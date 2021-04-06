import EventEmitter from 'eventemitter3'
import { deepMerge, setupInjectedStyle, genID, setupInjectedTheme, setupInjectedUI, deferred } from './helpers'
import Debug from 'debug'
import { LSPluginCaller, LSPMSG_READY, LSPMSG_SYNC, LSPMSG } from './LSPlugin.caller'
import { ILSPluginThemeManager, LSPluginPkgConfig, ThemeOptions, UIOptions } from './LSPlugin'
import { snakeCase } from 'snake-case'
import DOMPurify from 'dompurify'
import * as path from 'path'

const debug = Debug('LSPlugin:core')

declare global {
  interface Window {
    LSPluginCore: LSPluginCore
  }
}

type DeferredActor = ReturnType<typeof deferred>
type LSPluginCoreOptions = {
  localUserConfigRoot: string
}

/**
 * User settings
 */
class PluginSettings extends EventEmitter<'change'> {
  private _settings: Record<string, any> = {
    disabled: false
  }

  constructor (private _userPluginSettings: any) {
    super()

    Object.assign(this._settings, _userPluginSettings)
  }

  get<T = any> (k: string): T {
    return this._settings[k]
  }

  set (k: string | Record<string, any>, v?: any) {
    const o = deepMerge({}, this._settings)

    if (typeof k === 'string') {
      if (o[k] == v) return
      this._settings[k] = v
    } else {
      deepMerge(this._settings, k)
    }

    this.emit('change',
      Object.assign({}, this._settings), o)
  }

  toJSON () {
    return this._settings
  }
}

type UserPreferences = {
  theme: ThemeOptions
  externals: Array<string> // external plugin locations

  [key: string]: any
}

type PluginLocalOptions = {
  key?: string // Unique from Logseq Plugin Store
  entry: string // Plugin main file
  url: string // Plugin package fs location
  name: string
  version: string
  mode: 'shadow' | 'iframe'
  settings?: PluginSettings

  [key: string]: any
}

type PluginLocalUrl = Pick<PluginLocalOptions, 'url'> & { [key: string]: any }
type RegisterPluginOpts = PluginLocalOptions | PluginLocalUrl

type PluginLocalIdentity = string

enum PluginLocalLoadStatus {
  LOADING = 'loading',
  UNLOADING = 'unloading',
  LOADED = 'loaded',
  UNLOADED = 'unload',
  ERROR = 'error'
}

function initUserSettingsHandlers (pluginLocal: PluginLocal) {
  const _ = (label: string): any => `settings:${label}`

  pluginLocal.on(_('update'), (attrs) => {
    if (!attrs) return
    pluginLocal.settings?.set(attrs)
  })
}

function initMainUIHandlers (pluginLocal: PluginLocal) {
  const _ = (label: string): any => `main-ui:${label}`

  pluginLocal.on(_('visible'), ({ visible, toggle }) => {
    const el = pluginLocal.getMainUI()
    el?.classList[toggle ? 'toggle' : (visible ? 'add' : 'remove')]('visible')
  })

  pluginLocal.on(_('attrs'), (attrs: Record<string, any>) => {
    const el = pluginLocal.getMainUI()
    Object.entries(attrs).forEach(([k, v]) => {
      el?.setAttribute(k, v)
    })
  })

  pluginLocal.on(_('style'), (style: Record<string, any>) => {
    const el = pluginLocal.getMainUI()
    Object.entries(style).forEach(([k, v]) => {
      el!.style[k] = v
    })
  })
}

function initProviderHandlers (pluginLocal: PluginLocal) {
  let _ = (label: string): any => `provider:${label}`
  let themed = false

  pluginLocal.on(_('theme'), (theme: ThemeOptions) => {
    pluginLocal.themeMgr.registerTheme(
      pluginLocal.id,
      theme
    )

    if (!themed) {
      pluginLocal._dispose(() => {
        pluginLocal.themeMgr.unregisterTheme(pluginLocal.id)
      })

      themed = true
    }
  })

  pluginLocal.on(_('style'), (style: string) => {
    if (!style || !style.trim()) return
    pluginLocal._dispose(
      setupInjectedStyle(style, {
        'data-ref': pluginLocal.id
      })
    )
  })

  pluginLocal.on(_('ui'), (ui: UIOptions) => {
    // safe template
    ui.template = DOMPurify.sanitize(ui.template)

    pluginLocal._onHostMounted(() => {
      pluginLocal._dispose(
        setupInjectedUI.call(pluginLocal,
          ui, {
            'data-ref': pluginLocal.id
          })
      )
    })
  })
}

function initAppProxyHandlers (pluginLocal: PluginLocal) {
  let _ = (label: string): any => `app:${label}`

  pluginLocal.on(_('call'), (payload) => {
    const method = snakeCase(payload.method)

    const fn = window.api[method] || (() => new Error(`can not resolve API#${method}`))
    const rt = fn.apply(null, payload.args)
    const { _sync } = payload

    if (pluginLocal.shadow) {
      if (payload.actor) {
        payload.actor.resolve(rt)
      }
      return
    }

    if (_sync != null) {
      const reply = (result: any) => {
        pluginLocal.caller?.callUserModel(LSPMSG_SYNC, {
          result, _sync
        })
      }

      Promise.resolve(rt).then(reply, reply)
    }
  })
}

class IllegalPluginPackageError extends Error {
  constructor (message: string) {
    super(message)
    this.name = IllegalPluginPackageError.name
  }
}

class ExistedImportedPluginPackageError extends Error {
  constructor (message: string) {
    super(message)
    this.name = ExistedImportedPluginPackageError.name
  }
}

/**
 * Host plugin for local
 */
class PluginLocal
  extends EventEmitter<'loaded' | 'unloaded' | 'beforeunload' | 'error'> {

  private _disposes: Array<() => Promise<any>> = []
  private _id: PluginLocalIdentity
  private _status: PluginLocalLoadStatus = PluginLocalLoadStatus.UNLOADED
  private _loadErr?: Error
  private _localRoot?: string
  private _caller?: LSPluginCaller

  /**
   * @param _options
   * @param _themeMgr
   * @param _ctx
   */
  constructor (
    private _options: PluginLocalOptions,
    private _themeMgr: ILSPluginThemeManager,
    private _ctx: LSPluginCore
  ) {
    super()

    this._id = _options.key || genID()

    initUserSettingsHandlers(this)
    initMainUIHandlers(this)
    initProviderHandlers(this)
    initAppProxyHandlers(this)
  }

  async _setupUserSettings () {
    const { _options } = this

    try {
      const key = _options.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_' + this.id

      const userSettings = await window.api[`load_plugin_user_settings`](key)

      _options.settings = new PluginSettings(userSettings)

      // observe settings
      _options.settings.on('change', (a, b) => {
        debug('linked settings change', a)

        if (!a.disabled && b.disabled) {
          // Enable plugin
          this.load()
        }

        if (a.disabled && !b.disabled) {
          // Disable plugin
          this.unload()
        }

        if (a) {
          window.api[`save_plugin_user_settings`](key, a)
        }
      })
    } catch (e) {
      debug('[load plugin user settings Error]', e)
    }
  }

  getMainUI (): HTMLElement | undefined {
    if (this.shadow) {
      return this.caller?._getSandboxShadowContainer()
    }

    return this.caller?._getSandboxIframeContainer()
  }

  async _preparePackageConfigs () {
    const { url } = this._options
    let pkg: any

    try {
      if (!url) {
        throw new Error('Can not resolve package config location')
      }

      debug('prepare package root', url)

      pkg = await window.api.load_plugin_config(url)

      if (!pkg || (pkg = JSON.parse(pkg), !pkg)) {
        throw new Error(`Parse package config error #${url}/package.json`)
      }
    } catch (e) {
      throw new IllegalPluginPackageError(e.message)
    }

    // Pick legal attrs
    ['name', 'author', 'version', 'description', 'icon'].forEach(k => {
      this._options[k] = pkg[k]
    })

    // TODO: How with local protocol
    const localRoot = this._localRoot = url
    const makeFullUrl = (loc, useFileProtocol = false) => {
      const reg = /^(http|file|assets)/
      if (!reg.test(loc)) {
        const url = path.join(localRoot, loc)
        loc = reg.test(url) ? url : ('file://' + url)
      }
      return useFileProtocol ? loc : loc.replace('file:', 'assets:')
    }

    // Entry from main
    if (pkg.main) {
      this._options.entry = makeFullUrl(pkg.main, true)
    }

    if (pkg.icon) {
      this._options.icon = makeFullUrl(pkg.icon)
    }

    const logseq: LSPluginPkgConfig = pkg.logseq || {}

    if (logseq.mode) {
      this._options.mode = logseq.mode
    }

    // TODO: strategy for Logseq plugins center
    if (logseq.id) {
      this._id = logseq.id
    } else {
      logseq.id = this.id
      try {
        await window.api.save_plugin_config(url, { ...pkg, logseq })
      } catch (e) {
        debug('[save plugin ID Error] ', e)
      }
    }

    // Validate id
    const { registeredPlugins, isRegistering } = this._ctx
    if (isRegistering && registeredPlugins.has(logseq.id)) {
      throw new ExistedImportedPluginPackageError('prepare package Error')
    }

    return async () => {
      try {
        // 0. Install Themes
        let themes = logseq.themes

        if (themes) {
          await this._loadConfigThemes(
            Array.isArray(themes) ? themes : [themes]
          )
        }
      } catch (e) {
        debug('[prepare package effect Error]', e)
      }
    }
  }

  async _loadConfigThemes (themes: Array<ThemeOptions>) {
    themes.forEach((options) => {
      if (!options.url) return

      if (!options.url.startsWith('http') && this._localRoot) {
        options.url = path.join(this._localRoot, options.url)
        // file:// for native
        if (!options.url.startsWith('file:')) {
          options.url = 'assets://' + options.url
        }
      }

      // @ts-ignore
      this.emit('provider:theme', options)
    })
  }

  async load (readyIndicator?: DeferredActor) {
    if (this.pending) {
      return
    }

    this._status = PluginLocalLoadStatus.LOADING
    this._loadErr = undefined

    try {
      let installPackageThemes: () => Promise<void> = () => Promise.resolve()

      if (!this.options.entry) { // Themes package no entry field
        installPackageThemes = await this._preparePackageConfigs()
      }

      if (!this.settings) {
        await this._setupUserSettings()
      }

      if (!this.disabled) {
        await installPackageThemes.call(null)
      }

      if (this.disabled || !this.options.entry) {
        return
      }

      this._caller = new LSPluginCaller(this)
      await this._caller.connectToChild()

      const readyFn = () => {
        this._caller?.callUserModel(LSPMSG_READY)
      }

      if (readyIndicator) {
        readyIndicator.promise.then(readyFn)
      } else {
        readyFn()
      }

      this._disposes.push(async () => {
        await this._caller?.destroy()
      })
    } catch (e) {
      debug('[Load Plugin Error] ', e)

      this._status = PluginLocalLoadStatus.ERROR
      this._loadErr = e
    } finally {
      if (!this._loadErr) {
        this._status = PluginLocalLoadStatus.LOADED
      }
    }
  }

  async reload () {
    debug('TODO: reload plugin', this.id)
  }

  /**
   * @param unregister If true delete plugin files
   */
  async unload (unregister: boolean = false) {
    if (this.pending) {
      return
    }

    if (unregister) {
      await this.unload()
      // TODO: delete plugin local files
      return
    }

    try {
      this._status = PluginLocalLoadStatus.UNLOADING

      const eventBeforeUnload = {}

      // sync call
      try {
        this.emit('beforeunload', eventBeforeUnload)
      } catch (e) {
        console.error('[beforeunload Error]', e)
      }

      await this.dispose()

      this.emit('unloaded')
    } catch (e) {
      debug('[plugin unload Error]', e)
    } finally {
      this._status = PluginLocalLoadStatus.UNLOADED
    }
  }

  private async dispose () {
    for (const fn of this._disposes) {
      try {
        fn && (await fn())
      } catch (e) {
        console.error('[PluginLocal] Dispose Error', e)
      }
    }

    // clear
    this._disposes = []
  }

  _dispose (fn: any) {
    if (!fn) return
    this._disposes.push(fn)
  }

  _onHostMounted (callback: () => void) {
    const actor = this._ctx.readyIndicator

    if (false /*!actor || actor.settled*/) {
      callback()
    } else {
      const expiredTime = Date.now() - actor!.created

      // TODO: Fix impl
      actor?.promise.then(() => {
        setTimeout(callback, expiredTime > 3000 ? 0 : 1000)
      })
    }
  }

  get loaded () {
    return this._status === PluginLocalLoadStatus.LOADED
  }

  get pending () {
    return [PluginLocalLoadStatus.LOADING, PluginLocalLoadStatus.UNLOADING]
      .includes(this._status)
  }

  get status (): PluginLocalLoadStatus {
    return this._status
  }

  get settings () {
    return this.options.settings
  }

  get disabled () {
    return this.settings?.get('disabled')
  }

  get caller () {
    return this._caller
  }

  get id (): string {
    return this._id
  }

  get shadow (): boolean {
    return this.options.mode === 'shadow'
  }

  get options (): PluginLocalOptions {
    return this._options
  }

  get themeMgr (): ILSPluginThemeManager {
    return this._themeMgr
  }

  get debugTag () {
    return `[${this._options?.name} #${this._id}]`
  }

  get localRoot (): string {
    return this._localRoot || this._options.url
  }

  get loadErr (): Error | undefined {
    return this._loadErr
  }

  toJSON () {
    const json = { ...this.options } as any
    json.id = this.id
    json.err = this.loadErr
    return json
  }
}

/**
 * Host plugin core
 */
class LSPluginCore
  extends EventEmitter<'beforeenable' | 'enabled' | 'beforedisable' | 'disabled' | 'registered' | 'error' | 'unregistered' |
    'theme-changed' | 'theme-selected' | 'settings-changed'>
  implements ILSPluginThemeManager {

  private _isRegistering = false
  private _readyIndicator?: DeferredActor
  private _userPreferences: Partial<UserPreferences> = {}
  private _registeredThemes = new Map<PluginLocalIdentity, Array<ThemeOptions>>()
  private _registeredPlugins = new Map<PluginLocalIdentity, PluginLocal>()

  /**
   * @param _options
   */
  constructor (private _options: Partial<LSPluginCoreOptions>) {
    super()
  }

  async loadUserPreferences () {
    try {
      const settings = await window.api[`load_user_preferences`]()

      if (settings) {
        Object.assign(this._userPreferences, settings)
      }
    } catch (e) {
      debug('[load user preferences Error]', e)
    }
  }

  async saveUserPreferences (settings: Partial<UserPreferences>) {
    try {
      if (settings) {
        Object.assign(this._userPreferences, settings)
      }

      await window.api[`save_user_preferences`](this._userPreferences)
    } catch (e) {
      debug('[save user preferences Error]', e)
    }
  }

  async activateUserPreferences () {
    const { theme } = this._userPreferences

    // 0. theme
    if (theme) {
      await this.selectTheme(theme, false)
    }
  }

  /**
   * @param plugins
   * @param initial
   */
  async register (
    plugins: Array<RegisterPluginOpts> | RegisterPluginOpts,
    initial = false
  ) {
    if (!Array.isArray(plugins)) {
      await this.register([plugins])
      return
    }

    try {
      this._isRegistering = true

      const userConfigRoot = this._options.localUserConfigRoot
      const readyIndicator = this._readyIndicator = deferred()

      await this.loadUserPreferences()

      const externals = new Set(this._userPreferences.externals || [])

      if (initial) {
        plugins = plugins.concat([...externals].filter(url => {
          return !plugins.length || (plugins as RegisterPluginOpts[]).every((p) => !p.entry && (p.url !== url))
        }).map(url => ({ url })))
      }

      for (const pluginOptions of plugins) {

        const { url, entry } = pluginOptions as PluginLocalOptions
        const pluginLocal = new PluginLocal(pluginOptions as PluginLocalOptions, this, this)

        const timeLabel = `Load plugin #${pluginLocal.id}`
        console.time(timeLabel)

        await pluginLocal.load(readyIndicator)

        const { loadErr } = pluginLocal

        if (loadErr) {
          debug(`Failed load plugin #`, pluginOptions)

          this.emit('error', loadErr)

          if (
            loadErr instanceof IllegalPluginPackageError ||
            loadErr instanceof ExistedImportedPluginPackageError) {
            // TODO: notify global log system?
            continue
          }
        }

        console.timeEnd(timeLabel)

        pluginLocal.settings?.on('change', (a) => {
          this.emit('settings-changed', pluginLocal.id, a)
        })

        this._registeredPlugins.set(pluginLocal.id, pluginLocal)
        this.emit('registered', pluginLocal)

        // external plugins
        if (url && !entry && userConfigRoot) {
          if (url.indexOf(userConfigRoot) === -1) {
            externals.add(url)
          }
        }
      }

      await this.saveUserPreferences({ externals: Array.from(externals) })
      await this.activateUserPreferences()

      readyIndicator.resolve('ready')
    } catch (e) {
      console.error(e)
    } finally {
      this._isRegistering = false
    }
  }

  async reload (plugins: Array<PluginLocalIdentity> | PluginLocalIdentity) {
    if (!Array.isArray(plugins)) {
      await this.reload([plugins])
      return
    }

    for (const identity of plugins) {
      const p = this.ensurePlugin(identity)
      await p.reload()
    }
  }

  async unregister (plugins: Array<PluginLocalIdentity> | PluginLocalIdentity) {
    if (!Array.isArray(plugins)) {
      await this.unregister([plugins])
      return
    }

    for (const identity of plugins) {
      const p = this.ensurePlugin(identity)
      await p.unload(true)

      this._registeredPlugins.delete(identity)
      this.emit('unregistered', identity)
    }
  }

  async enable (plugin: PluginLocalIdentity) {
    const p = this.ensurePlugin(plugin)
    if (p.pending) return

    this.emit('beforeenable')
    p.settings?.set('disabled', false)
    // this.emit('enabled', p)
  }

  async disable (plugin: PluginLocalIdentity) {
    const p = this.ensurePlugin(plugin)
    if (p.pending) return

    this.emit('beforedisable')
    p.settings?.set('disabled', true)
    // this.emit('disabled', p)
  }

  async _hook (ns: string, type: string, payload?: any) {
    for (const [_, p] of this._registeredPlugins) {
      p.caller && p.caller.callUserModel(LSPMSG, {
        ns, type: snakeCase(type), payload
      })
    }
  }

  hookApp (type: string, payload?: any) {
    this._hook(`hook:app`, type, payload)
  }

  hookEditor (type: string, payload?: any) {
    this._hook(`hook:editor`, type, payload)
  }

  _execDirective (tag: string, ...params: any[]) {

  }

  ensurePlugin (plugin: PluginLocalIdentity | PluginLocal) {
    if (plugin instanceof PluginLocal) {
      return plugin
    }

    const p = this._registeredPlugins.get(plugin)

    if (!p) {
      throw new Error(`plugin #${plugin} not existed.`)
    }

    return p
  }

  get registeredPlugins (): Map<PluginLocalIdentity, PluginLocal> {
    return this._registeredPlugins
  }

  get options (): any {
    return this._options
  }

  get readyIndicator (): DeferredActor | undefined {
    return this._readyIndicator
  }

  get isRegistering (): boolean {
    return this._isRegistering
  }

  get themes (): Map<PluginLocalIdentity, Array<ThemeOptions>> {
    return this._registeredThemes
  }

  async registerTheme (id: PluginLocalIdentity, opt: ThemeOptions): Promise<void> {
    debug('registered Theme #', id, opt)

    if (!id) return
    let themes: Array<ThemeOptions> = this._registeredThemes.get(id)!
    if (!themes) {
      this._registeredThemes.set(id, themes = [])
    }

    themes.push(opt)
    this.emit('theme-changed', this.themes, { id, ...opt })
  }

  async selectTheme (opt?: ThemeOptions, effect = true): Promise<void> {
    setupInjectedTheme(opt?.url)
    this.emit('theme-selected', opt)
    effect && this.saveUserPreferences({ theme: opt })
  }

  async unregisterTheme (id: PluginLocalIdentity): Promise<void> {
    debug('unregistered Theme #', id)

    if (!this._registeredThemes.has(id)) return
    this._registeredThemes.delete(id)
    this.emit('theme-changed', this.themes, { id })
  }
}

function setupPluginCore (options: any) {
  const pluginCore = new LSPluginCore(options)

  debug('=== 🔗 Setup Logseq Plugin System 🔗 ===')

  window.LSPluginCore = pluginCore
}

export {
  PluginLocal,
  setupPluginCore
}