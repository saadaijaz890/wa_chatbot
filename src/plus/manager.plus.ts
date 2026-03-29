import {
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SessionManagerCore } from '@waha/core/manager.core';
import { DefaultMap } from '@waha/utils/DefaultMap';
import { SwitchObservable } from '@waha/utils/reactive/SwitchObservable';
import { complete } from '@waha/utils/reactive/complete';
import { WAHAEvents, WAHASessionStatus } from '@waha/structures/enums.dto';
import {
  SessionConfig,
  SessionDetailedInfo,
  SessionDTO,
  SessionInfo,
} from '@waha/structures/sessions.dto';
import { WhatsappSession } from '@waha/core/abc/session.abc';
import { populateSessionInfo } from '@waha/core/abc/manager.abc';
import { getPinoLogLevel, LoggerBuilder } from '@waha/utils/logging';
import { WebhookConductor } from '@waha/core/integrations/webhooks/WebhookConductor';
import { MediaManager } from '@waha/core/media/MediaManager';
import { sleep } from '@waha/utils/promiseTimeout';
import { Observable, retry, share } from 'rxjs';
import { map } from 'rxjs/operators';
import { WhatsappSessionWebJSCore } from '@waha/core/engines/webjs/session.webjs.core';
import { WhatsappSessionWPPCore } from '@waha/core/engines/wpp/session.wpp.core';
import { WhatsappSessionGoWSCore } from '@waha/core/engines/gows/session.gows.core';
import { promiseTimeout } from '@waha/utils/promiseTimeout';
import { LocalSessionConfigRepository } from '@waha/core/storage/LocalSessionConfigRepository';
import { CoreApiKeyRepository } from '@waha/core/storage/CoreApiKeyRepository';

@Injectable()
export class SessionManagerPlus extends SessionManagerCore implements OnModuleInit {
  // Multiple sessions storage
  private sessions: Map<string, WhatsappSession | null | undefined> = new Map();
  private sessionConfigs: Map<string, SessionConfig | undefined> = new Map();
  // Per-session event observables
  private perSessionEvents: Map<
    string,
    DefaultMap<WAHAEvents, SwitchObservable<any>>
  > = new Map();

  // Override onlyDefault to be a no-op — allow any session name
  protected onlyDefault(name: string): void {
    void name;
    // Plus version allows any session name
  }

  // Override clearStorage to skip the media purge — Plus preserves session data across restarts
  protected async clearStorage(): Promise<void> {
    return;
  }

  // Override onApplicationBootstrap to load persisted sessions and optionally restart them
  async onApplicationBootstrap() {
    this.apiKeyRepository = new CoreApiKeyRepository();
    await this.engineBootstrap.bootstrap();
    await this.loadPersistedSessions();
    this.startPredefinedSessions();
  }

  private async loadPersistedSessions() {
    const configRepo = this
      .sessionConfigRepository as LocalSessionConfigRepository;
    if (!configRepo) {
      return;
    }
    let allSessionNames: string[];
    try {
      allSessionNames = await configRepo.getAllConfigs();
    } catch (error) {
      this.log.error({ error: `${error}` }, 'Failed to load persisted sessions');
      return;
    }

    for (const name of allSessionNames) {
      const config = await configRepo.getConfig(name);
      this.sessionConfigs.set(name, config ?? undefined);
      if (!this.sessions.has(name)) {
        this.sessions.set(name, null); // stopped, not removed
      }
    }

    if (!this.config.shouldRestartAllSessions) {
      return;
    }

    for (const name of allSessionNames) {
      this.withLock(name, async () => {
        const log = this.log.logger.child({ session: name });
        log.info('Restarting persisted session...');
        await this.start(name).catch((error) => {
          log.error(`Failed to restart persisted session: ${error}`);
        });
      });
    }
  }

  // Override onModuleInit to also init the config repository
  async onModuleInit() {
    await this.init();
    this.sessionConfigRepository = new LocalSessionConfigRepository(
      this.store,
    );
    await this.sessionConfigRepository.init();
  }

  // Override exists to use the sessions map
  async exists(name: string): Promise<boolean> {
    return this.sessions.has(name) && this.sessions.get(name) !== undefined;
  }

  // Override isRunning to use the sessions map
  isRunning(name: string): boolean {
    const session = this.sessions.get(name);
    return !!session;
  }

  // Override upsert to persist the config and update the sessions map
  async upsert(name: string, config?: SessionConfig): Promise<void> {
    this.sessionConfigs.set(name, config);
    if (!this.sessions.has(name)) {
      this.sessions.set(name, null); // mark as stopped (not removed)
    }
    if (this.sessionConfigRepository) {
      await this.sessionConfigRepository.saveConfig(name, config ?? {});
    }
  }

  // Override start to use Map-based storage
  async start(name: string): Promise<SessionDTO> {
    if (this.isRunning(name)) {
      throw new UnprocessableEntityException(
        `Session '${name}' is already started.`,
      );
    }

    // Ensure session is tracked in the map (auto-create if started directly)
    if (!this.sessions.has(name)) {
      this.sessions.set(name, null);
    }

    this.log.info({ session: name }, `Starting session...`);
    const config = this.sessionConfigs.get(name);
    const logger = this.log.logger.child({ session: name });
    logger.level = getPinoLogLevel(config?.debug);
    const loggerBuilder: LoggerBuilder = logger;

    const storage = await this.mediaStorageFactory.build(
      name,
      loggerBuilder.child({ name: 'Storage' }),
    );
    await storage.init();
    const mediaManager = new MediaManager(
      storage,
      this.config.mimetypes,
      loggerBuilder.child({ name: 'MediaManager' }),
    );

    const webhook = new WebhookConductor(loggerBuilder);
    const proxyConfig = this.getProxyConfigForSession(name);
    const sessionParams: any = {
      name,
      mediaManager,
      loggerBuilder,
      printQR: this.engineConfigService.shouldPrintQR,
      sessionStore: this.store,
      proxyConfig,
      sessionConfig: config,
      ignore: this.ignoreChatsConfig(config),
    };

    if (this.EngineClass === WhatsappSessionWebJSCore) {
      sessionParams.engineConfig = this.webjsEngineConfigService.getConfig();
    } else if (this.EngineClass === WhatsappSessionWPPCore) {
      sessionParams.engineConfig = this.wppEngineConfigService.getConfig();
    } else if (this.EngineClass === WhatsappSessionGoWSCore) {
      sessionParams.engineConfig = this.gowsConfigService.getConfig();
    }

    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new this.EngineClass(sessionParams);
    this.sessions.set(name, session);
    this.updateSessionEvents(name, session);

    // configure webhooks
    const webhooks = this.getWebhooksForSession(name);
    webhook.configure(session, webhooks);

    // Apps
    try {
      await this.appsService.beforeSessionStart(session, this.store);
    } catch (e) {
      logger.error(`Apps Error: ${e}`);
      session.status = WAHASessionStatus.FAILED;
    }

    if (session.status !== WAHASessionStatus.FAILED) {
      await session.start();
      logger.info('Session has been started.');
      await this.appsService.afterSessionStart(session, this.store);
    }

    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  // Override stop to use Map
  async stop(name: string, silent: boolean): Promise<void> {
    if (!this.isRunning(name)) {
      this.log.debug({ session: name }, `Session is not running.`);
      return;
    }

    this.log.info({ session: name }, `Stopping session...`);
    try {
      const session = this.getSession(name);
      await session.stop();
    } catch (err) {
      this.log.warn(`Error while stopping session '${name}'`);
      if (!silent) {
        throw err;
      }
    }
    this.log.info({ session: name }, `Session has been stopped.`);
    this.sessions.set(name, null); // stopped but not removed
    this.clearSessionEvents(name);
    await sleep(this.SESSION_STOP_TIMEOUT);
  }

  // Override logout to use Map
  async logout(name: string): Promise<void> {
    await this.sessionAuthRepository.clean(name);
  }

  // Override delete to use Map and remove persisted config
  async delete(name: string): Promise<void> {
    await this.appsService.removeBySession(this, name);
    this.sessions.set(name, undefined); // removed
    this.clearSessionEvents(name);
    this.sessionConfigs.delete(name);
    if (this.sessionConfigRepository) {
      await this.sessionConfigRepository.deleteConfig(name);
    }
  }

  // Override unpair
  async unpair(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) {
      return;
    }
    this.log.info({ session: name }, 'Unpairing the device from account...');
    await (session as WhatsappSession).unpair().catch((err) => {
      this.log.warn(`Error while unpairing from device: ${err}`);
    });
    await sleep(1000);
  }

  // Override getSession to use Map
  getSession(name: string): WhatsappSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'.\n` +
          `Please start it first by using POST /api/sessions/${name}/start request`,
      );
    }
    return session as WhatsappSession;
  }

  // Override getSessions to iterate all sessions
  async getSessions(all: boolean): Promise<SessionInfo[]> {
    const results: SessionInfo[] = [];

    for (const [name, session] of this.sessions.entries()) {
      if (session === undefined) {
        // removed — skip in all cases
        continue;
      }
      if (session === null) {
        // stopped
        if (all) {
          results.push({
            name,
            status: WAHASessionStatus.STOPPED,
            config: this.sessionConfigs.get(name),
            me: null,
            presence: null,
            timestamps: { activity: null },
          });
        }
        continue;
      }
      // running
      const me = (session as WhatsappSession).getSessionMeInfo();
      results.push({
        name,
        status: (session as WhatsappSession).status,
        config: (session as WhatsappSession).sessionConfig,
        me,
        presence: (session as WhatsappSession).presence,
        timestamps: {
          activity: (session as WhatsappSession).getLastActivityTimestamp(),
        },
      });
    }
    return results;
  }

  // Override getSessionInfo
  async getSessionInfo(name: string): Promise<SessionDetailedInfo | null> {
    const sessions = await this.getSessions(true);
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return null;
    }
    const engine = await this.fetchEngineInfoForSession(name);
    return {
      ...session,
      engine,
    };
  }

  // Override getSessionEvent to return per-session events
  getSessionEvent(sessionName: string, event: WAHAEvents): Observable<any> {
    const sessionEvents = this.perSessionEvents.get(sessionName);
    if (!sessionEvents) {
      return new Observable();
    }
    return sessionEvents.get(event);
  }

  // Override beforeApplicationShutdown to stop ALL sessions
  async beforeApplicationShutdown(signal?: string) {
    for (const name of this.sessions.keys()) {
      if (this.isRunning(name)) {
        await this.stop(name, true).catch(() => {});
      }
    }
    this.stopAllEvents();
    await this.engineBootstrap.shutdown();
  }

  // Private helpers
  private updateSessionEvents(name: string, session: WhatsappSession) {
    if (!this.perSessionEvents.has(name)) {
      this.perSessionEvents.set(
        name,
        new DefaultMap<WAHAEvents, SwitchObservable<any>>(
          (_key) => new SwitchObservable((obs$) => obs$.pipe(retry(), share())),
        ),
      );
    }
    const events = this.perSessionEvents.get(name)!;
    for (const eventName in WAHAEvents) {
      const event = WAHAEvents[eventName];
      const stream$ = session
        .getEventObservable(event)
        .pipe(map(populateSessionInfo(event, session)));
      events.get(event).switch(stream$);
    }
  }

  private clearSessionEvents(name: string) {
    const events = this.perSessionEvents.get(name);
    if (events) {
      complete(events);
      this.perSessionEvents.delete(name);
    }
  }

  private stopAllEvents() {
    for (const events of this.perSessionEvents.values()) {
      complete(events);
    }
    this.perSessionEvents.clear();
  }

  private getProxyConfigForSession(name: string) {
    const config = this.sessionConfigs.get(name);
    if (config?.proxy) {
      return config.proxy;
    }
    return undefined;
  }

  private getWebhooksForSession(name: string) {
    let webhooks: any[] = [];
    const config = this.sessionConfigs.get(name);
    if (config?.webhooks) {
      webhooks = webhooks.concat(config.webhooks);
    }
    const globalWebhook = this.config.getWebhookConfig();
    if (globalWebhook) {
      webhooks.push(globalWebhook);
    }
    return webhooks;
  }

  private async fetchEngineInfoForSession(name: string) {
    const session = this.sessions.get(name) as WhatsappSession;
    let engineInfo = {};
    if (session) {
      try {
        engineInfo = await promiseTimeout(1000, session.getEngineInfo());
      } catch (error) {
        this.log.debug(
          { session: name, error: `${error}` },
          'Can not get engine info',
        );
      }
    }
    return {
      engine: session?.engine,
      ...engineInfo,
    };
  }
}
