/**
 * @license
 * Copyright 2017 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Protocol} from 'devtools-protocol';

import {firstValueFrom, from, raceWith} from '../../third_party/rxjs/rxjs.js';
import type {Browser} from '../api/Browser.js';
import type {BrowserContext} from '../api/BrowserContext.js';
import {CDPSessionEvent, type CDPSession} from '../api/CDPSession.js';
import type {ElementHandle} from '../api/ElementHandle.js';
import type {Frame, WaitForOptions} from '../api/Frame.js';
import type {HTTPRequest} from '../api/HTTPRequest.js';
import type {HTTPResponse} from '../api/HTTPResponse.js';
import type {JSHandle} from '../api/JSHandle.js';
import type {Credentials} from '../api/Page.js';
import {
  Page,
  PageEvent,
  type GeolocationOptions,
  type MediaFeature,
  type Metrics,
  type NewDocumentScriptEvaluation,
  type ScreenshotClip,
  type ScreenshotOptions,
  type WaitTimeoutOptions,
} from '../api/Page.js';
import {
  ConsoleMessage,
  type ConsoleMessageType,
} from '../common/ConsoleMessage.js';
import type {
  Cookie,
  DeleteCookiesRequest,
  CookieParam,
} from '../common/Cookie.js';
import {TargetCloseError} from '../common/Errors.js';
import {FileChooser} from '../common/FileChooser.js';
import {NetworkManagerEvent} from '../common/NetworkManagerEvents.js';
import type {PDFOptions} from '../common/PDFOptions.js';
import type {BindingPayload, HandleFor} from '../common/types.js';
import {
  debugError,
  evaluationString,
  getReadableAsBuffer,
  getReadableFromProtocolStream,
  parsePDFOptions,
  timeout,
  validateDialogType,
} from '../common/util.js';
import type {Viewport} from '../common/Viewport.js';
import {assert} from '../util/assert.js';
import {Deferred} from '../util/Deferred.js';
import {AsyncDisposableStack} from '../util/disposable.js';
import {isErrorLike} from '../util/ErrorLike.js';

import {Binding} from './Binding.js';
import {CdpCDPSession} from './CDPSession.js';
import {isTargetClosedError} from './Connection.js';
import {Coverage} from './Coverage.js';
import type {DeviceRequestPrompt} from './DeviceRequestPrompt.js';
import {CdpDialog} from './Dialog.js';
import {EmulationManager} from './EmulationManager.js';
import {FirefoxTargetManager} from './FirefoxTargetManager.js';
import type {CdpFrame} from './Frame.js';
import {FrameManager} from './FrameManager.js';
import {FrameManagerEvent} from './FrameManagerEvents.js';
import {CdpKeyboard, CdpMouse, CdpTouchscreen} from './Input.js';
import type {IsolatedWorld} from './IsolatedWorld.js';
import {MAIN_WORLD} from './IsolatedWorlds.js';
import {releaseObject} from './JSHandle.js';
import type {NetworkConditions} from './NetworkManager.js';
import type {CdpTarget} from './Target.js';
import type {TargetManager} from './TargetManager.js';
import {TargetManagerEvent} from './TargetManager.js';
import {Tracing} from './Tracing.js';
import {
  createClientError,
  pageBindingInitString,
  valueFromRemoteObject,
} from './utils.js';
import {CdpWebWorker} from './WebWorker.js';

function convertConsoleMessageLevel(method: string): ConsoleMessageType {
  switch (method) {
    case 'warning':
      return 'warn';
    default:
      return method as ConsoleMessageType;
  }
}

/**
 * @internal
 */
export class CdpPage extends Page {
  static async _create(
    client: CDPSession,
    target: CdpTarget,
    defaultViewport: Viewport | null
  ): Promise<CdpPage> {
    const page = new CdpPage(client, target);
    await page.#initialize();
    if (defaultViewport) {
      try {
        await page.setViewport(defaultViewport);
      } catch (err) {
        if (isErrorLike(err) && isTargetClosedError(err)) {
          debugError(err);
        } else {
          throw err;
        }
      }
    }
    return page;
  }

  #closed = false;
  readonly #targetManager: TargetManager;

  #primaryTargetClient: CDPSession;
  #primaryTarget: CdpTarget;
  #tabTargetClient: CDPSession;
  #tabTarget: CdpTarget;
  #keyboard: CdpKeyboard;
  #mouse: CdpMouse;
  #touchscreen: CdpTouchscreen;
  #frameManager: FrameManager;
  #emulationManager: EmulationManager;
  #tracing: Tracing;
  #bindings = new Map<string, Binding>();
  #exposedFunctions = new Map<string, string>();
  #coverage: Coverage;
  #viewport: Viewport | null;
  #workers = new Map<string, CdpWebWorker>();
  #fileChooserDeferreds = new Set<Deferred<FileChooser>>();
  #sessionCloseDeferred = Deferred.create<never, TargetCloseError>();
  #serviceWorkerBypassed = false;
  #userDragInterceptionEnabled = false;

  readonly #frameManagerHandlers = [
    [
      FrameManagerEvent.FrameAttached,
      (frame: CdpFrame) => {
        this.emit(PageEvent.FrameAttached, frame);
      },
    ],
    [
      FrameManagerEvent.FrameDetached,
      (frame: CdpFrame) => {
        this.emit(PageEvent.FrameDetached, frame);
      },
    ],
    [
      FrameManagerEvent.FrameNavigated,
      (frame: CdpFrame) => {
        this.emit(PageEvent.FrameNavigated, frame);
      },
    ],
  ] as const;

  readonly #networkManagerHandlers = [
    [
      NetworkManagerEvent.Request,
      (request: HTTPRequest) => {
        this.emit(PageEvent.Request, request);
      },
    ],
    [
      NetworkManagerEvent.RequestServedFromCache,
      (request: HTTPRequest) => {
        this.emit(PageEvent.RequestServedFromCache, request);
      },
    ],
    [
      NetworkManagerEvent.Response,
      (response: HTTPResponse) => {
        this.emit(PageEvent.Response, response);
      },
    ],
    [
      NetworkManagerEvent.RequestFailed,
      (request: HTTPRequest) => {
        this.emit(PageEvent.RequestFailed, request);
      },
    ],
    [
      NetworkManagerEvent.RequestFinished,
      (request: HTTPRequest) => {
        this.emit(PageEvent.RequestFinished, request);
      },
    ],
  ] as const;

  readonly #sessionHandlers = [
    [
      CDPSessionEvent.Disconnected,
      () => {
        this.#sessionCloseDeferred.reject(
          new TargetCloseError('Target closed')
        );
      },
    ],
    [
      'Page.domContentEventFired',
      () => {
        return this.emit(PageEvent.DOMContentLoaded, undefined);
      },
    ],
    [
      'Page.loadEventFired',
      () => {
        return this.emit(PageEvent.Load, undefined);
      },
    ],
    ['Page.javascriptDialogOpening', this.#onDialog.bind(this)],
    ['Runtime.exceptionThrown', this.#handleException.bind(this)],
    ['Inspector.targetCrashed', this.#onTargetCrashed.bind(this)],
    ['Performance.metrics', this.#emitMetrics.bind(this)],
    ['Log.entryAdded', this.#onLogEntryAdded.bind(this)],
    ['Page.fileChooserOpened', this.#onFileChooser.bind(this)],
  ] as const;

  constructor(client: CDPSession, target: CdpTarget) {
    super();
    this.#primaryTargetClient = client;
    this.#tabTargetClient = client.parentSession()!;
    assert(this.#tabTargetClient, 'Tab target session is not defined.');
    this.#tabTarget = (this.#tabTargetClient as CdpCDPSession)._target();
    assert(this.#tabTarget, 'Tab target is not defined.');
    this.#primaryTarget = target;
    this.#targetManager = target._targetManager();
    this.#keyboard = new CdpKeyboard(client);
    this.#mouse = new CdpMouse(client, this.#keyboard);
    this.#touchscreen = new CdpTouchscreen(client, this.#keyboard);
    this.#frameManager = new FrameManager(client, this, this._timeoutSettings);
    this.#emulationManager = new EmulationManager(client);
    this.#tracing = new Tracing(client);
    this.#coverage = new Coverage(client);
    this.#viewport = null;

    for (const [eventName, handler] of this.#frameManagerHandlers) {
      this.#frameManager.on(eventName, handler);
    }

    this.#frameManager.on(
      FrameManagerEvent.ConsoleApiCalled,
      ([world, event]: [
        IsolatedWorld,
        Protocol.Runtime.ConsoleAPICalledEvent,
      ]) => {
        this.#onConsoleAPI(world, event);
      }
    );

    this.#frameManager.on(
      FrameManagerEvent.BindingCalled,
      ([world, event]: [
        IsolatedWorld,
        Protocol.Runtime.BindingCalledEvent,
      ]) => {
        void this.#onBindingCalled(world, event);
      }
    );

    for (const [eventName, handler] of this.#networkManagerHandlers) {
      // TODO: Remove any.
      this.#frameManager.networkManager.on(eventName, handler as any);
    }

    this.#tabTargetClient.on(
      CDPSessionEvent.Swapped,
      this.#onActivation.bind(this)
    );

    this.#tabTargetClient.on(
      CDPSessionEvent.Ready,
      this.#onSecondaryTarget.bind(this)
    );

    this.#targetManager.on(
      TargetManagerEvent.TargetGone,
      this.#onDetachedFromTarget
    );

    this.#tabTarget._isClosedDeferred
      .valueOrThrow()
      .then(() => {
        this.#targetManager.off(
          TargetManagerEvent.TargetGone,
          this.#onDetachedFromTarget
        );

        this.emit(PageEvent.Close, undefined);
        this.#closed = true;
      })
      .catch(debugError);

    this.#setupPrimaryTargetListeners();
    this.#attachExistingTargets();
  }

  #attachExistingTargets(): void {
    const queue = [];
    for (const childTarget of this.#targetManager.getChildTargets(
      this.#primaryTarget
    )) {
      queue.push(childTarget);
    }
    let idx = 0;
    while (idx < queue.length) {
      const next = queue[idx] as CdpTarget;
      idx++;
      const session = next._session();
      if (session) {
        this.#onAttachedToTarget(session);
      }
      for (const childTarget of this.#targetManager.getChildTargets(next)) {
        queue.push(childTarget);
      }
    }
  }

  async #onActivation(newSession: CDPSession): Promise<void> {
    this.#primaryTargetClient = newSession;
    assert(
      this.#primaryTargetClient instanceof CdpCDPSession,
      'CDPSession is not instance of CDPSessionImpl'
    );
    this.#primaryTarget = this.#primaryTargetClient._target();
    assert(this.#primaryTarget, 'Missing target on swap');
    this.#keyboard.updateClient(newSession);
    this.#mouse.updateClient(newSession);
    this.#touchscreen.updateClient(newSession);
    this.#emulationManager.updateClient(newSession);
    this.#tracing.updateClient(newSession);
    this.#coverage.updateClient(newSession);
    await this.#frameManager.swapFrameTree(newSession);
    this.#setupPrimaryTargetListeners();
  }

  async #onSecondaryTarget(session: CDPSession): Promise<void> {
    assert(session instanceof CdpCDPSession);
    if (session._target()._subtype() !== 'prerender') {
      return;
    }
    this.#frameManager.registerSpeculativeSession(session).catch(debugError);
    this.#emulationManager
      .registerSpeculativeSession(session)
      .catch(debugError);
  }

  /**
   * Sets up listeners for the primary target. The primary target can change
   * during a navigation to a prerended page.
   */
  #setupPrimaryTargetListeners() {
    this.#primaryTargetClient.on(
      CDPSessionEvent.Ready,
      this.#onAttachedToTarget
    );

    for (const [eventName, handler] of this.#sessionHandlers) {
      // TODO: Remove any.
      this.#primaryTargetClient.on(eventName, handler as any);
    }
  }

  #onDetachedFromTarget = (target: CdpTarget) => {
    const sessionId = target._session()?.id();
    const worker = this.#workers.get(sessionId!);
    if (!worker) {
      return;
    }
    this.#workers.delete(sessionId!);
    this.emit(PageEvent.WorkerDestroyed, worker);
  };

  #onAttachedToTarget = (session: CDPSession) => {
    assert(session instanceof CdpCDPSession);
    this.#frameManager.onAttachedToTarget(session._target());
    if (session._target()._getTargetInfo().type === 'worker') {
      const worker = new CdpWebWorker(
        session,
        session._target().url(),
        session._target()._targetId,
        session._target().type(),
        this.#addConsoleMessage.bind(this),
        this.#handleException.bind(this)
      );
      this.#workers.set(session.id(), worker);
      this.emit(PageEvent.WorkerCreated, worker);
    }
    session.on(CDPSessionEvent.Ready, this.#onAttachedToTarget);
  };

  async #initialize(): Promise<void> {
    try {
      await Promise.all([
        this.#frameManager.initialize(this.#primaryTargetClient),
        this.#primaryTargetClient.send('Performance.enable'),
        this.#primaryTargetClient.send('Log.enable'),
      ]);
    } catch (err) {
      if (isErrorLike(err) && isTargetClosedError(err)) {
        debugError(err);
      } else {
        throw err;
      }
    }
  }

  async #onFileChooser(
    event: Protocol.Page.FileChooserOpenedEvent
  ): Promise<void> {
    if (!this.#fileChooserDeferreds.size) {
      return;
    }

    const frame = this.#frameManager.frame(event.frameId);
    assert(frame, 'This should never happen.');

    // This is guaranteed to be an HTMLInputElement handle by the event.
    using handle = (await frame.worlds[MAIN_WORLD].adoptBackendNode(
      event.backendNodeId
    )) as ElementHandle<HTMLInputElement>;

    const fileChooser = new FileChooser(handle.move(), event);
    for (const promise of this.#fileChooserDeferreds) {
      promise.resolve(fileChooser);
    }
    this.#fileChooserDeferreds.clear();
  }

  _client(): CDPSession {
    return this.#primaryTargetClient;
  }

  override isServiceWorkerBypassed(): boolean {
    return this.#serviceWorkerBypassed;
  }

  override isDragInterceptionEnabled(): boolean {
    return this.#userDragInterceptionEnabled;
  }

  override isJavaScriptEnabled(): boolean {
    return this.#emulationManager.javascriptEnabled;
  }

  override async waitForFileChooser(
    options: WaitTimeoutOptions = {}
  ): Promise<FileChooser> {
    const needsEnable = this.#fileChooserDeferreds.size === 0;
    const {timeout = this._timeoutSettings.timeout()} = options;
    const deferred = Deferred.create<FileChooser>({
      message: `Waiting for \`FileChooser\` failed: ${timeout}ms exceeded`,
      timeout,
    });
    this.#fileChooserDeferreds.add(deferred);
    let enablePromise: Promise<void> | undefined;
    if (needsEnable) {
      enablePromise = this.#primaryTargetClient.send(
        'Page.setInterceptFileChooserDialog',
        {
          enabled: true,
        }
      );
    }
    try {
      const [result] = await Promise.all([
        deferred.valueOrThrow(),
        enablePromise,
      ]);
      return result;
    } catch (error) {
      this.#fileChooserDeferreds.delete(deferred);
      throw error;
    }
  }

  override async setGeolocation(options: GeolocationOptions): Promise<void> {
    return await this.#emulationManager.setGeolocation(options);
  }

  override target(): CdpTarget {
    return this.#primaryTarget;
  }

  override browser(): Browser {
    return this.#primaryTarget.browser();
  }

  override browserContext(): BrowserContext {
    return this.#primaryTarget.browserContext();
  }

  #onTargetCrashed(): void {
    this.emit(PageEvent.Error, new Error('Page crashed!'));
  }

  #onLogEntryAdded(event: Protocol.Log.EntryAddedEvent): void {
    const {level, text, args, source, url, lineNumber} = event.entry;
    if (args) {
      args.map(arg => {
        void releaseObject(this.#primaryTargetClient, arg);
      });
    }
    if (source !== 'worker') {
      this.emit(
        PageEvent.Console,
        new ConsoleMessage(
          convertConsoleMessageLevel(level),
          text,
          [],
          [{url, lineNumber}]
        )
      );
    }
  }

  override mainFrame(): CdpFrame {
    return this.#frameManager.mainFrame();
  }

  override get keyboard(): CdpKeyboard {
    return this.#keyboard;
  }

  override get touchscreen(): CdpTouchscreen {
    return this.#touchscreen;
  }

  override get coverage(): Coverage {
    return this.#coverage;
  }

  override get tracing(): Tracing {
    return this.#tracing;
  }

  override frames(): Frame[] {
    return this.#frameManager.frames();
  }

  override workers(): CdpWebWorker[] {
    return Array.from(this.#workers.values());
  }

  override async setRequestInterception(value: boolean): Promise<void> {
    return await this.#frameManager.networkManager.setRequestInterception(
      value
    );
  }

  override async setBypassServiceWorker(bypass: boolean): Promise<void> {
    this.#serviceWorkerBypassed = bypass;
    return await this.#primaryTargetClient.send(
      'Network.setBypassServiceWorker',
      {bypass}
    );
  }

  override async setDragInterception(enabled: boolean): Promise<void> {
    this.#userDragInterceptionEnabled = enabled;
    return await this.#primaryTargetClient.send('Input.setInterceptDrags', {
      enabled,
    });
  }

  override async setOfflineMode(enabled: boolean): Promise<void> {
    return await this.#frameManager.networkManager.setOfflineMode(enabled);
  }

  override async emulateNetworkConditions(
    networkConditions: NetworkConditions | null
  ): Promise<void> {
    return await this.#frameManager.networkManager.emulateNetworkConditions(
      networkConditions
    );
  }

  override setDefaultNavigationTimeout(timeout: number): void {
    this._timeoutSettings.setDefaultNavigationTimeout(timeout);
  }

  override setDefaultTimeout(timeout: number): void {
    this._timeoutSettings.setDefaultTimeout(timeout);
  }

  override getDefaultTimeout(): number {
    return this._timeoutSettings.timeout();
  }

  override async queryObjects<Prototype>(
    prototypeHandle: JSHandle<Prototype>
  ): Promise<JSHandle<Prototype[]>> {
    assert(!prototypeHandle.disposed, 'Prototype JSHandle is disposed!');
    assert(
      prototypeHandle.id,
      'Prototype JSHandle must not be referencing primitive value'
    );
    const response = await this.mainFrame().client.send(
      'Runtime.queryObjects',
      {
        prototypeObjectId: prototypeHandle.id,
      }
    );
    return this.mainFrame()
      .mainRealm()
      .createCdpHandle(response.objects) as HandleFor<Prototype[]>;
  }

  override async cookies(...urls: string[]): Promise<Cookie[]> {
    const originalCookies = (
      await this.#primaryTargetClient.send('Network.getCookies', {
        urls: urls.length ? urls : [this.url()],
      })
    ).cookies;

    const unsupportedCookieAttributes = ['sourcePort'];
    const filterUnsupportedAttributes = (
      cookie: Protocol.Network.Cookie
    ): Protocol.Network.Cookie => {
      for (const attr of unsupportedCookieAttributes) {
        delete (cookie as unknown as Record<string, unknown>)[attr];
      }
      return cookie;
    };
    return originalCookies.map(filterUnsupportedAttributes);
  }

  override async deleteCookie(
    ...cookies: DeleteCookiesRequest[]
  ): Promise<void> {
    const pageURL = this.url();
    for (const cookie of cookies) {
      const item = Object.assign({}, cookie);
      if (!cookie.url && pageURL.startsWith('http')) {
        item.url = pageURL;
      }
      await this.#primaryTargetClient.send('Network.deleteCookies', item);
    }
  }

  override async setCookie(...cookies: CookieParam[]): Promise<void> {
    const pageURL = this.url();
    const startsWithHTTP = pageURL.startsWith('http');
    const items = cookies.map(cookie => {
      const item = Object.assign({}, cookie);
      if (!item.url && startsWithHTTP) {
        item.url = pageURL;
      }
      assert(
        item.url !== 'about:blank',
        `Blank page can not have cookie "${item.name}"`
      );
      assert(
        !String.prototype.startsWith.call(item.url || '', 'data:'),
        `Data URL page can not have cookie "${item.name}"`
      );
      return item;
    });
    await this.deleteCookie(...items);
    if (items.length) {
      await this.#primaryTargetClient.send('Network.setCookies', {
        cookies: items,
      });
    }
  }

  override async exposeFunction(
    name: string,
    pptrFunction: Function | {default: Function}
  ): Promise<void> {
    if (this.#bindings.has(name)) {
      throw new Error(
        `Failed to add page binding with name ${name}: window['${name}'] already exists!`
      );
    }
    const source = pageBindingInitString('exposedFun', name);
    let binding: Binding;
    switch (typeof pptrFunction) {
      case 'function':
        binding = new Binding(
          name,
          pptrFunction as (...args: unknown[]) => unknown,
          source
        );
        break;
      default:
        binding = new Binding(
          name,
          pptrFunction.default as (...args: unknown[]) => unknown,
          source
        );
        break;
    }
    this.#bindings.set(name, binding);
    const [{identifier}] = await Promise.all([
      this.#frameManager.evaluateOnNewDocument(source),
      this.#frameManager.addExposedFunctionBinding(binding),
    ]);
    this.#exposedFunctions.set(name, identifier);
  }

  override async removeExposedFunction(name: string): Promise<void> {
    const exposedFunctionId = this.#exposedFunctions.get(name);
    if (!exposedFunctionId) {
      throw new Error(`Function with name "${name}" does not exist`);
    }
    // #bindings must be updated together with #exposedFunctions.
    const binding = this.#bindings.get(name)!;
    this.#exposedFunctions.delete(name);
    this.#bindings.delete(name);
    await Promise.all([
      this.#frameManager.removeScriptToEvaluateOnNewDocument(exposedFunctionId),
      this.#frameManager.removeExposedFunctionBinding(binding),
    ]);
  }

  override async authenticate(credentials: Credentials | null): Promise<void> {
    return await this.#frameManager.networkManager.authenticate(credentials);
  }

  override async setExtraHTTPHeaders(
    headers: Record<string, string>
  ): Promise<void> {
    return await this.#frameManager.networkManager.setExtraHTTPHeaders(headers);
  }

  override async setUserAgent(
    userAgent: string,
    userAgentMetadata?: Protocol.Emulation.UserAgentMetadata
  ): Promise<void> {
    return await this.#frameManager.networkManager.setUserAgent(
      userAgent,
      userAgentMetadata
    );
  }

  override async metrics(): Promise<Metrics> {
    const response = await this.#primaryTargetClient.send(
      'Performance.getMetrics'
    );
    return this.#buildMetricsObject(response.metrics);
  }

  #emitMetrics(event: Protocol.Performance.MetricsEvent): void {
    this.emit(PageEvent.Metrics, {
      title: event.title,
      metrics: this.#buildMetricsObject(event.metrics),
    });
  }

  #buildMetricsObject(metrics?: Protocol.Performance.Metric[]): Metrics {
    const result: Record<
      Protocol.Performance.Metric['name'],
      Protocol.Performance.Metric['value']
    > = {};
    for (const metric of metrics || []) {
      if (supportedMetrics.has(metric.name)) {
        result[metric.name] = metric.value;
      }
    }
    return result;
  }

  #handleException(exception: Protocol.Runtime.ExceptionThrownEvent): void {
    this.emit(
      PageEvent.PageError,
      createClientError(exception.exceptionDetails)
    );
  }

  #onConsoleAPI(
    world: IsolatedWorld,
    event: Protocol.Runtime.ConsoleAPICalledEvent
  ): void {
    const values = event.args.map(arg => {
      return world.createCdpHandle(arg);
    });
    this.#addConsoleMessage(
      convertConsoleMessageLevel(event.type),
      values,
      event.stackTrace
    );
  }

  async #onBindingCalled(
    world: IsolatedWorld,
    event: Protocol.Runtime.BindingCalledEvent
  ): Promise<void> {
    let payload: BindingPayload;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      // The binding was either called by something in the page or it was
      // called before our wrapper was initialized.
      return;
    }
    const {type, name, seq, args, isTrivial} = payload;
    if (type !== 'exposedFun') {
      return;
    }

    const context = world.context;
    if (!context) {
      return;
    }

    const binding = this.#bindings.get(name);
    await binding?.run(context, seq, args, isTrivial);
  }

  #addConsoleMessage(
    eventType: string,
    args: JSHandle[],
    stackTrace?: Protocol.Runtime.StackTrace
  ): void {
    if (!this.listenerCount(PageEvent.Console)) {
      args.forEach(arg => {
        return arg.dispose();
      });
      return;
    }
    const textTokens = [];
    // eslint-disable-next-line max-len -- The comment is long.
    // eslint-disable-next-line rulesdir/use-using -- These are not owned by this function.
    for (const arg of args) {
      const remoteObject = arg.remoteObject();
      if (remoteObject.objectId) {
        textTokens.push(arg.toString());
      } else {
        textTokens.push(valueFromRemoteObject(remoteObject));
      }
    }
    const stackTraceLocations = [];
    if (stackTrace) {
      for (const callFrame of stackTrace.callFrames) {
        stackTraceLocations.push({
          url: callFrame.url,
          lineNumber: callFrame.lineNumber,
          columnNumber: callFrame.columnNumber,
        });
      }
    }
    const message = new ConsoleMessage(
      convertConsoleMessageLevel(eventType),
      textTokens.join(' '),
      args,
      stackTraceLocations
    );
    this.emit(PageEvent.Console, message);
  }

  #onDialog(event: Protocol.Page.JavascriptDialogOpeningEvent): void {
    const type = validateDialogType(event.type);
    const dialog = new CdpDialog(
      this.#primaryTargetClient,
      type,
      event.message,
      event.defaultPrompt
    );
    this.emit(PageEvent.Dialog, dialog);
  }

  override async reload(
    options?: WaitForOptions
  ): Promise<HTTPResponse | null> {
    const [result] = await Promise.all([
      this.waitForNavigation({
        ...options,
        ignoreSameDocumentNavigation: true,
      }),
      this.#primaryTargetClient.send('Page.reload'),
    ]);

    return result;
  }

  override async createCDPSession(): Promise<CDPSession> {
    return await this.target().createCDPSession();
  }

  override async goBack(
    options: WaitForOptions = {}
  ): Promise<HTTPResponse | null> {
    return await this.#go(-1, options);
  }

  override async goForward(
    options: WaitForOptions = {}
  ): Promise<HTTPResponse | null> {
    return await this.#go(+1, options);
  }

  async #go(
    delta: number,
    options: WaitForOptions
  ): Promise<HTTPResponse | null> {
    const history = await this.#primaryTargetClient.send(
      'Page.getNavigationHistory'
    );
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) {
      return null;
    }
    const result = await Promise.all([
      this.waitForNavigation(options),
      this.#primaryTargetClient.send('Page.navigateToHistoryEntry', {
        entryId: entry.id,
      }),
    ]);
    return result[0];
  }

  override async bringToFront(): Promise<void> {
    await this.#primaryTargetClient.send('Page.bringToFront');
  }

  override async setJavaScriptEnabled(enabled: boolean): Promise<void> {
    return await this.#emulationManager.setJavaScriptEnabled(enabled);
  }

  override async setBypassCSP(enabled: boolean): Promise<void> {
    await this.#primaryTargetClient.send('Page.setBypassCSP', {enabled});
  }

  override async emulateMediaType(type?: string): Promise<void> {
    return await this.#emulationManager.emulateMediaType(type);
  }

  override async emulateCPUThrottling(factor: number | null): Promise<void> {
    return await this.#emulationManager.emulateCPUThrottling(factor);
  }

  override async emulateMediaFeatures(
    features?: MediaFeature[]
  ): Promise<void> {
    return await this.#emulationManager.emulateMediaFeatures(features);
  }

  override async emulateTimezone(timezoneId?: string): Promise<void> {
    return await this.#emulationManager.emulateTimezone(timezoneId);
  }

  override async emulateIdleState(overrides?: {
    isUserActive: boolean;
    isScreenUnlocked: boolean;
  }): Promise<void> {
    return await this.#emulationManager.emulateIdleState(overrides);
  }

  override async emulateVisionDeficiency(
    type?: Protocol.Emulation.SetEmulatedVisionDeficiencyRequest['type']
  ): Promise<void> {
    return await this.#emulationManager.emulateVisionDeficiency(type);
  }

  override async setViewport(viewport: Viewport | null): Promise<void> {
    const needsReload = await this.#emulationManager.emulateViewport(viewport);
    this.#viewport = viewport;
    if (needsReload) {
      await this.reload();
    }
  }

  override viewport(): Viewport | null {
    return this.#viewport;
  }

  override async evaluateOnNewDocument<
    Params extends unknown[],
    Func extends (...args: Params) => unknown = (...args: Params) => unknown,
  >(
    pageFunction: Func | string,
    ...args: Params
  ): Promise<NewDocumentScriptEvaluation> {
    const source = evaluationString(pageFunction, ...args);
    return await this.#frameManager.evaluateOnNewDocument(source);
  }

  override async removeScriptToEvaluateOnNewDocument(
    identifier: string
  ): Promise<void> {
    return await this.#frameManager.removeScriptToEvaluateOnNewDocument(
      identifier
    );
  }

  override async setCacheEnabled(enabled = true): Promise<void> {
    await this.#frameManager.networkManager.setCacheEnabled(enabled);
  }

  override async _screenshot(
    options: Readonly<ScreenshotOptions>
  ): Promise<string> {
    const {
      fromSurface,
      omitBackground,
      optimizeForSpeed,
      quality,
      clip: userClip,
      type,
      captureBeyondViewport,
    } = options;

    const isFirefox =
      this.target()._targetManager() instanceof FirefoxTargetManager;

    await using stack = new AsyncDisposableStack();
    // Firefox omits background by default; it's not configurable.
    if (!isFirefox && omitBackground && (type === 'png' || type === 'webp')) {
      await this.#emulationManager.setTransparentBackgroundColor();
      stack.defer(async () => {
        await this.#emulationManager
          .resetDefaultBackgroundColor()
          .catch(debugError);
      });
    }

    let clip = userClip;
    if (clip && !captureBeyondViewport) {
      const viewport = await this.mainFrame()
        .isolatedRealm()
        .evaluate(() => {
          const {
            height,
            pageLeft: x,
            pageTop: y,
            width,
          } = window.visualViewport!;
          return {x, y, height, width};
        });
      clip = getIntersectionRect(clip, viewport);
    }

    // We need to do these spreads because Firefox doesn't allow unknown options.
    const {data} = await this.#primaryTargetClient.send(
      'Page.captureScreenshot',
      {
        format: type,
        ...(optimizeForSpeed ? {optimizeForSpeed} : {}),
        ...(quality !== undefined ? {quality: Math.round(quality)} : {}),
        ...(clip ? {clip: {...clip, scale: clip.scale ?? 1}} : {}),
        ...(!fromSurface ? {fromSurface} : {}),
        captureBeyondViewport,
      }
    );
    return data;
  }

  override async createPDFStream(
    options: PDFOptions = {}
  ): Promise<ReadableStream<Uint8Array>> {
    const {timeout: ms = this._timeoutSettings.timeout()} = options;
    const {
      landscape,
      displayHeaderFooter,
      headerTemplate,
      footerTemplate,
      printBackground,
      scale,
      width: paperWidth,
      height: paperHeight,
      margin,
      pageRanges,
      preferCSSPageSize,
      omitBackground,
      tagged: generateTaggedPDF,
      outline: generateDocumentOutline,
      waitForFonts,
    } = parsePDFOptions(options);

    if (omitBackground) {
      await this.#emulationManager.setTransparentBackgroundColor();
    }

    if (waitForFonts) {
      await firstValueFrom(
        from(
          this.mainFrame()
            .isolatedRealm()
            .evaluate(() => {
              return document.fonts.ready;
            })
        ).pipe(raceWith(timeout(ms)))
      );
    }

    const printCommandPromise = this.#primaryTargetClient.send(
      'Page.printToPDF',
      {
        transferMode: 'ReturnAsStream',
        landscape,
        displayHeaderFooter,
        headerTemplate,
        footerTemplate,
        printBackground,
        scale,
        paperWidth,
        paperHeight,
        marginTop: margin.top,
        marginBottom: margin.bottom,
        marginLeft: margin.left,
        marginRight: margin.right,
        pageRanges,
        preferCSSPageSize,
        generateTaggedPDF,
        generateDocumentOutline,
      }
    );

    const result = await firstValueFrom(
      from(printCommandPromise).pipe(raceWith(timeout(ms)))
    );

    if (omitBackground) {
      await this.#emulationManager.resetDefaultBackgroundColor();
    }

    assert(result.stream, '`stream` is missing from `Page.printToPDF');
    return await getReadableFromProtocolStream(
      this.#primaryTargetClient,
      result.stream
    );
  }

  override async pdf(options: PDFOptions = {}): Promise<Buffer> {
    const {path = undefined} = options;
    const readable = await this.createPDFStream(options);
    const buffer = await getReadableAsBuffer(readable, path);
    assert(buffer, 'Could not create buffer');
    return buffer;
  }

  override async close(
    options: {runBeforeUnload?: boolean} = {runBeforeUnload: undefined}
  ): Promise<void> {
    const connection = this.#primaryTargetClient.connection();
    assert(
      connection,
      'Protocol error: Connection closed. Most likely the page has been closed.'
    );
    const runBeforeUnload = !!options.runBeforeUnload;
    if (runBeforeUnload) {
      await this.#primaryTargetClient.send('Page.close');
    } else {
      await connection.send('Target.closeTarget', {
        targetId: this.#primaryTarget._targetId,
      });
      await this.#tabTarget._isClosedDeferred.valueOrThrow();
    }
  }

  override isClosed(): boolean {
    return this.#closed;
  }

  override get mouse(): CdpMouse {
    return this.#mouse;
  }

  /**
   * This method is typically coupled with an action that triggers a device
   * request from an api such as WebBluetooth.
   *
   * :::caution
   *
   * This must be called before the device request is made. It will not return a
   * currently active device prompt.
   *
   * :::
   *
   * @example
   *
   * ```ts
   * const [devicePrompt] = Promise.all([
   *   page.waitForDevicePrompt(),
   *   page.click('#connect-bluetooth'),
   * ]);
   * await devicePrompt.select(
   *   await devicePrompt.waitForDevice(({name}) => name.includes('My Device'))
   * );
   * ```
   */
  override async waitForDevicePrompt(
    options: WaitTimeoutOptions = {}
  ): Promise<DeviceRequestPrompt> {
    return await this.mainFrame().waitForDevicePrompt(options);
  }
}

const supportedMetrics = new Set<string>([
  'Timestamp',
  'Documents',
  'Frames',
  'JSEventListeners',
  'Nodes',
  'LayoutCount',
  'RecalcStyleCount',
  'LayoutDuration',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration',
  'JSHeapUsedSize',
  'JSHeapTotalSize',
]);

/** @see https://w3c.github.io/webdriver-bidi/#rectangle-intersection */
function getIntersectionRect(
  clip: Readonly<ScreenshotClip>,
  viewport: Readonly<Protocol.DOM.Rect>
): ScreenshotClip {
  // Note these will already be normalized.
  const x = Math.max(clip.x, viewport.x);
  const y = Math.max(clip.y, viewport.y);
  return {
    x,
    y,
    width: Math.max(
      Math.min(clip.x + clip.width, viewport.x + viewport.width) - x,
      0
    ),
    height: Math.max(
      Math.min(clip.y + clip.height, viewport.y + viewport.height) - y,
      0
    ),
  };
}
