/*
 * Browser runtime port of Unfolded Circle remote-ui.
 * Source design: remote-ui QML (GPL-3.0-or-later).
 */
(function remoteUiWebFactory() {
  "use strict";

  const GLYPHS = Object.freeze({
    home: "\uf015", gear: "\uf013", bell: "\uf0f3", battery: "\uf242", bolt: "\uf0e7", wifi: "\uf1eb",
    left: "\uf053", right: "\uf054", up: "\uf077", down: "\uf078", close: "\uf00d", power: "\uf011",
    play: "\uf04b", pause: "\uf04c", stop: "\uf04d", previous: "\uf048", next: "\uf051", volume: "\uf028",
    mute: "\uf6a9", light: "\uf0eb", climate: "\uf2c9", cover: "\uf8fb", switch: "\uf205", button: "\uf25a",
    select: "\ue489", sensor: "\uf624", group: "\uf5fd", activity: "\uf144", media: "\uf26c", remote: "\uf11b",
    macro: "\ue2ca", info: "\uf05a", update: "\uf0ed", plug: "\uf1e6", check: "\uf058", warning: "\uf071",
    voice: "\uf130", sleep: "\uf186", restart: "\uf2f1", back: "\uf060", menu: "\uf0c9", plus: "+", minus: "\uf068",
    palette: "\uf53f", brightness: "\ue28f", sliders: "\uf1de", more: "\uf141", music: "\uf001", film: "\uf008",
    broadcast: "\uf519", circle: "\uf111", lock: "\uf023", link: "\ue1cb", nodes: "\ue4e2", fan: "\uf863",
    coffee: "\uf7b6", globe: "\uf57d", user: "\uf007", door: "\uf52b", humidity: "\uf043", temperature: "\uf2c8"
  });

  const TYPE_ICON = Object.freeze({
    activity: "activity", media_player: "media", light: "light", cover: "cover", climate: "climate", switch: "switch",
    button: "button", select: "select", sensor: "sensor", group: "group", remote: "remote", macro: "macro"
  });

  const DEVICE_ICON = Object.freeze({
    temperature: "temperature", humidity: "humidity", power: "bolt", battery: "battery", outlet: "plug", tv: "media",
    speaker: "volume", blind: "cover", curtain: "cover", garage: "door", window: "cover"
  });

  function html(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function clamp(value, min, max) {
    const number = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
  }

  function typeOf(entity) {
    return String(entity?.entity_type || entity?.type || "").toLowerCase();
  }

  function attrs(entity) {
    return entity?.attributes || {};
  }

  function entityState(entity) {
    const value = attrs(entity).state ?? entity?.state ?? attrs(entity).value ?? entity?.value;
    return String(value ?? "").toLowerCase();
  }

  function isActive(entity) {
    const type = typeOf(entity);
    const value = entityState(entity);
    if (entity?.available === false || ["unavailable", "unknown", "disconnected"].includes(value)) return false;
    if (type === "button") return false;
    if (type === "cover") return !["closed", "off", "0"].includes(value) || coverPosition(entity) > 0;
    if (type === "sensor" || type === "select") return true;
    if (type === "climate") return !["off", "idle", ""].includes(String(attrs(entity).hvac_mode || value).toLowerCase());
    return !["off", "idle", "paused", "stopped", "closed", "false", "0", ""].includes(value);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function coverPosition(entity) {
    return clamp(attrs(entity).current_position ?? attrs(entity).position ?? 0, 0, 100);
  }

  function brightness(entity) {
    const raw = attrs(entity).brightness ?? 0;
    return clamp(number(raw) > 100 ? number(raw) / 2.55 : raw, 0, 100);
  }

  function climate(entity) {
    const a = attrs(entity);
    return {
      current: number(a.current_temperature ?? a.temperature, 21),
      target: number(a.target_temperature ?? a.temperature, 22),
      step: number(a.target_temperature_step, 0.5) || 0.5,
      unit: String(a.temperature_unit || a.unit || "°C"),
      mode: String(a.hvac_mode || a.state || "off").toLowerCase(),
      modes: Array.isArray(a.hvac_modes) ? a.hvac_modes : Array.isArray(a.options) ? a.options : ["off", "heat", "cool", "auto"],
      humidity: number(a.humidity, 0)
    };
  }

  function media(entity) {
    const a = attrs(entity);
    return {
      state: String(a.state || "off").toLowerCase(),
      title: String(a.media_title || a.title || "Nothing playing"),
      artist: String(a.media_artist || a.artist || a.media_album || ""),
      album: String(a.media_album || ""),
      art: String(a.media_image_url || a.artwork_url || a.media_image || ""),
      position: Math.max(0, number(a.media_position, 0)),
      duration: Math.max(0, number(a.media_duration, 0)),
      volume: clamp(number(a.volume ?? a.volume_level, 0), 0, number(a.volume ?? 0) <= 1 ? 1 : 100),
      muted: Boolean(a.muted ?? a.is_muted),
      source: String(a.source || ""),
      sources: Array.isArray(a.source_list) ? a.source_list : [],
      soundMode: String(a.sound_mode || ""),
      soundModes: Array.isArray(a.sound_mode_list) ? a.sound_mode_list : []
    };
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(number(seconds)));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remaining = value % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}` : `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  function icon(name, className = "") {
    return `<span class="uc-remote-ui__icon ${className}" aria-hidden="true">${GLYPHS[name] || GLYPHS.circle}</span>`;
  }

  function iconName(entity) {
    const identifier = String(entity?.icon || "").replace(/^uc:/, "").toLowerCase();
    const aliases = {
      "light-bulb": "light", "lightbulb": "light", "temperature-half": "temperature", temperature: "temperature",
      blinds: "cover", "window-blinds": "cover", tv: "media", mediaplayer: "media", "media-player": "media",
      "gamepad-modern": "remote", beaker: "info", "wand-magic-sparkles": "macro", "mug-hot": "coffee",
      droplet: "humidity", "battery-half": "battery", palette: "palette", fan: "fan", bell: "bell", house: "home"
    };
    if (aliases[identifier]) return aliases[identifier];
    if (GLYPHS[identifier]) return identifier;
    return DEVICE_ICON[String(entity?.device_class || "").toLowerCase()] || TYPE_ICON[typeOf(entity)] || "circle";
  }

  function resourceUrl(model, kind, value) {
    const text = String(value || "");
    if (!text) return "";
    if (typeof model.resourceUrl === "function") return model.resourceUrl(kind, text);
    return "";
  }

  function entityIcon(model, entity, className = "") {
    const custom = resourceUrl(model, "Icon", entity?.icon);
    if (custom) return `<span class="uc-remote-ui__entity-icon ${className}"><img src="${html(custom)}" alt=""></span>`;
    return `<span class="uc-remote-ui__entity-icon ${className}">${icon(iconName(entity))}</span>`;
  }

  function entityName(model, entity, fallback = "Unnamed") {
    return model.nameOf ? model.nameOf(entity?.name || entity?.display_name, fallback) : String(entity?.name || fallback);
  }

  function idOf(model, value) {
    return model.idOf ? model.idOf(value) : String(value?.entity_id || value?.id || "");
  }

  function stateLabel(entity) {
    const type = typeOf(entity);
    const a = attrs(entity);
    if (entity?.available === false) return "unavailable";
    if (type === "sensor") return `${a.value ?? a.state ?? "—"}${a.unit ? ` ${a.unit}` : ""}`;
    if (type === "media_player") return String(a.media_title || a.state || "off");
    if (type === "climate") return `${number(a.current_temperature, 0).toFixed(1)}${a.temperature_unit || "°C"} · ${String(a.hvac_mode || a.state || "off").toLowerCase()}`;
    if (type === "cover") return `${Math.round(coverPosition(entity))}% · ${String(a.state || "stopped").toLowerCase()}`;
    if (type === "light") return isActive(entity) ? `${Math.round(brightness(entity))}%` : "off";
    if (type === "select") return String(a.current_option || a.state || "");
    if (type === "button") return `${number(a.press_count, 0)} presses`;
    if (type === "macro") return String(a.state || "idle").toLowerCase();
    if (type === "switch" && a.power_w !== undefined) return `${String(a.state || "off").toLowerCase()} · ${Math.round(number(a.power_w))} W`;
    if (type === "remote") return `${String(a.state || "on").toLowerCase()} · ${a.last_command || "ready"}`;
    return String(a.state ?? entity?.state ?? "").toLowerCase();
  }

  function commandId(type, action) {
    const map = {
      light: { on: "light.on", off: "light.off", toggle: "light.toggle", brightness: "light.brightness", temperature: "light.color_temperature", color: "light.color" },
      switch: { on: "switch.on", off: "switch.off", toggle: "switch.toggle" },
      cover: { open: "cover.open", close: "cover.close", stop: "cover.stop", position: "cover.position" },
      climate: { temperature: "climate.set_temperature", mode: "climate.set_mode", on: "climate.on", off: "climate.off" },
      media_player: { toggle: "media_player.toggle", play_pause: "media_player.play_pause", previous: "media_player.previous", next: "media_player.next", stop: "media_player.stop", volume: "media_player.volume", mute: "media_player.mute_toggle", seek: "media_player.seek", source: "media_player.select_source", sound: "media_player.select_sound_mode" },
      select: { option: "select.select_option" }, button: { push: "button.push" }, macro: { start: "macro.start" }, activity: { on: "activity.on", off: "activity.off" }
    };
    return map[type]?.[action] || `${type}.${action}`;
  }

  class RemoteUIWeb {
    constructor(options) {
      this.root = options.root;
      this.actions = options.actions || {};
      this.model = null;
      this.local = {
        section: "home",
        detailTab: 0,
        groupDetailId: "",
        mediaBrowserEntityId: "",
        mediaItems: [],
        mediaLoading: false,
        powerOpen: false,
        voiceOpen: false,
        chargingOpen: false,
        volume: null,
        toast: null,
        toastTimer: null,
        selectedMenuIndex: 0,
        sensorHistory: new Map()
      };
      this.lastDetailId = "";
      this.view = { detailKey: "", sectionKey: "", systemKey: "", toastKey: "" };
      this.gesture = null;
      this.bound = false;
      this.clockTimer = setInterval(() => this.updateClock(), 1000);
      this.bind();
    }

    destroy() {
      clearInterval(this.clockTimer);
    }

    bind() {
      if (this.bound) return;
      this.bound = true;
      this.root.addEventListener("click", (event) => this.onClick(event));
      this.root.addEventListener("change", (event) => this.onChange(event));
      this.root.addEventListener("input", (event) => this.onInput(event));
    }

    update(model) {
      this.model = model;
      this.root.style.setProperty("--rui-accent", String(model.state?.settings?.accent || "#769990"));
      const detail = this.detailEntity();
      const detailId = detail ? idOf(model, detail) : "";
      if (detailId !== this.lastDetailId) {
        this.local.detailTab = 0;
        this.lastDetailId = detailId;
      }
      this.captureSensorHistory();
      this.render();
    }

    captureSensorHistory() {
      if (!this.model) return;
      for (const entity of this.model.state.entities.values()) {
        if (typeOf(entity) !== "sensor") continue;
        const id = idOf(this.model, entity);
        const value = number(attrs(entity).value ?? attrs(entity).state, 0);
        const values = this.local.sensorHistory.get(id) || [];
        if (!values.length || values.at(-1) !== value) values.push(value);
        while (values.length > 18) values.shift();
        this.local.sensorHistory.set(id, values);
      }
    }

    baseScreen() {
      return this.model?.state.screens[this.model.state.screenIndex] || null;
    }

    baseItems() {
      return this.model?.screenItems?.(this.baseScreen()) || [];
    }

    pageActivity() {
      const items = this.baseItems();
      const onPage = items.map((item) => item.data).find((entity) => typeOf(entity) === "activity");
      return this.model?.state?.activeActivity || onPage || null;
    }

    pageMedia(activity = this.pageActivity()) {
      if (!activity) return null;
      const included = activity.options?.included_entities || activity.included_entities || activity.entities || [];
      const found = included.find((entity) => typeOf(entity) === "media_player");
      if (found) return this.model.state.entities.get(idOf(this.model, found)) || found;
      return null;
    }

    activityHeaderMarkup(activity) {
      if (!activity || this.model.state.settings?.enable_activity_bar === false) return "";
      const entityId = idOf(this.model, activity);
      const mediaEntity = this.pageMedia(activity);
      const mediaData = mediaEntity ? media(mediaEntity) : null;
      const rawArt = mediaData?.art || "";
      const art = rawArt.startsWith("/") ? `${this.model.sessionBase || ""}${rawArt}` : (/^https?:|^data:|^blob:/i.test(rawArt) ? rawArt : resourceUrl(this.model, "Icon", rawArt));
      const state = String(activity.state || attrs(activity).state || "off").toLowerCase();
      const visual = art
        ? `<div class="uc-remote-ui__activity-media"><img src="${html(art)}" alt=""><div><strong>${html(mediaData.title)}</strong><span>${html([mediaData.artist, mediaData.album].filter(Boolean).join(" · "))}</span></div></div>`
        : `<div class="uc-remote-ui__activity-icon">${entityIcon(this.model, activity)}</div>`;
      return `<button type="button" class="uc-remote-ui__activity-header ${art ? "has-media" : ""}" data-rui-open-entity="${html(entityId)}"><small>${html(entityName(this.model, activity, "Activity"))} is ${html(state)}</small>${visual}</button>`;
    }

    detailEntity() {
      const state = this.model?.state;
      if (!state) return null;
      if (state.activityOverlayOpen) return state.overlayEntity || state.activeActivity;
      if (state.entityControlOpen) return state.controlEntity;
      return null;
    }

    currentMediaPlayer() {
      const state = this.model?.state;
      if (!state) return null;
      const detail = this.detailEntity();
      if (typeOf(detail) === "media_player") return detail;
      const included = detail?.options?.included_entities || detail?.included_entities || detail?.entities || state.activeActivity?.options?.included_entities || [];
      const found = included.find((entity) => typeOf(entity) === "media_player");
      if (found) return state.entities.get(idOf(this.model, found)) || found;
      return [...state.entities.values()].find((entity) => typeOf(entity) === "media_player") || null;
    }

    render() {
      if (!this.model) return;
      if (!this.root.querySelector("[data-rui-shell]")) {
        this.root.innerHTML = `<div class="uc-remote-ui__surface" data-rui-shell><div class="uc-remote-ui__base-host" data-rui-base-host></div><div class="uc-remote-ui__overlay-host" data-rui-detail-host></div><div class="uc-remote-ui__overlay-host" data-rui-section-host></div><div class="uc-remote-ui__system-host" data-rui-system-host></div><div class="uc-remote-ui__toast-host" data-rui-toast-host></div></div>`;
      }

      const baseHost = this.root.querySelector("[data-rui-base-host]");
      const oldScroll = baseHost.querySelector("[data-rui-page-scroll]")?.scrollTop || 0;
      baseHost.innerHTML = `${this.statusBar()}<div class="uc-remote-ui__pages">${this.basePage()}</div>`;
      const newScroll = baseHost.querySelector("[data-rui-page-scroll]");
      if (newScroll) newScroll.scrollTop = oldScroll;

      const detail = this.detailEntity();
      const detailHost = this.root.querySelector("[data-rui-detail-host]");
      if (detail) {
        const key = `${typeOf(detail)}:${idOf(this.model, detail)}:${this.local.detailTab}:${this.model.state.activityOverlayIndex || 0}`;
        const markup = this.detailMarkup(detail);
        this.syncOverlayHost(detailHost, markup, key, this.model.state.activityOverlayClosing || this.model.state.entityControlClosing);
      } else {
        detailHost.replaceChildren();
        this.view.detailKey = "";
      }

      const sectionHost = this.root.querySelector("[data-rui-section-host]");
      let sectionMarkup = "";
      let sectionKey = "";
      if (!detail && this.local.groupDetailId) {
        sectionMarkup = this.groupDetailMarkup();
        sectionKey = `group:${this.local.groupDetailId}`;
      } else if (!detail && this.local.section !== "home") {
        sectionMarkup = this.sectionMarkup();
        sectionKey = `${this.local.section}:${this.local.mediaBrowserEntityId}:${idOf(this.model, this.model.state.profile)}`;
      }
      if (sectionMarkup) this.syncOverlayHost(sectionHost, sectionMarkup, sectionKey, false);
      else { sectionHost.replaceChildren(); this.view.sectionKey = ""; }

      // MainContainer.qml scales and fades the primary page whenever a
      // second container is loaded. Keep that state independent from data
      // reconciliation so an open detail remains visually stable.
      baseHost.classList.toggle("is-obscured", Boolean(detail || sectionMarkup));

      const systemHost = this.root.querySelector("[data-rui-system-host]");
      const systemKey = [this.local.powerOpen, this.local.voiceOpen, this.local.chargingOpen, this.local.volume?.entityId || ""].join(":");
      if (systemKey !== this.view.systemKey) {
        systemHost.innerHTML = this.systemOverlays();
        this.view.systemKey = systemKey;
      } else {
        const battery = systemHost.querySelector("[data-rui-charge-level]");
        if (battery) battery.textContent = `${clamp(this.model.state.settings.battery_level ?? 82,0,100)}%`;
        const meter = systemHost.querySelector(".uc-remote-ui__volume-meter span");
        if (meter && this.local.volume) meter.style.width = `${clamp(this.local.volume.value,0,100)}%`;
      }

      const toastHost = this.root.querySelector("[data-rui-toast-host]");
      const toastKey = this.local.toast ? `${this.local.toast.error}:${this.local.toast.message}` : "";
      if (toastKey !== this.view.toastKey) {
        toastHost.innerHTML = this.toastMarkup();
        this.view.toastKey = toastKey;
      }
      this.updateClock();
    }

    syncOverlayHost(host, markup, key, closing = false) {
      const scrollNode = host.querySelector(".uc-remote-ui__detail-body,.uc-remote-ui__menu");
      const scroll = scrollNode?.scrollTop || 0;
      const focus = document.activeElement && host.contains(document.activeElement)
        ? {
            name: document.activeElement.getAttribute("name") || "",
            range: document.activeElement.dataset?.ruiRange || "",
            entity: document.activeElement.dataset?.ruiEntity || "",
            selectionStart: document.activeElement.selectionStart,
            selectionEnd: document.activeElement.selectionEnd
          }
        : null;
      const template = document.createElement("template");
      template.innerHTML = markup.trim();
      const fresh = template.content.firstElementChild;
      if (!fresh) return;
      let current = host.firstElementChild;
      const firstMount = !current;
      if (firstMount) {
        host.appendChild(fresh);
        current = fresh;
        // QML's second container animates only when it is pushed. Mark the
        // persistent browser container after that first transition so Core
        // refreshes and command responses cannot replay the entrance.
        const settle = () => current?.classList.add("is-mounted");
        current.addEventListener("animationend", settle, { once: true });
        setTimeout(settle, 360);
      } else {
        const mounted = current.classList.contains("is-mounted");
        const closingClass = current.classList.contains("is-closing");
        // Keep the same outer node. Replacing it (or assigning className)
        // restarts CSS transitions and was the reason overlays appeared to
        // close and reopen on every command and 2.5 s refresh.
        current.innerHTML = fresh.innerHTML;
        for (const attr of [...current.attributes]) {
          if (!["class", "data-rui-view-key"].includes(attr.name) && !fresh.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        }
        for (const attr of [...fresh.attributes]) {
          if (attr.name !== "class") current.setAttribute(attr.name, attr.value);
        }
        const nextClasses = new Set(fresh.classList);
        for (const className of [...current.classList]) {
          if (!["is-mounted", "is-closing"].includes(className) && !nextClasses.has(className)) current.classList.remove(className);
        }
        for (const className of nextClasses) current.classList.add(className);
        if (mounted) current.classList.add("is-mounted");
        if (closingClass) current.classList.add("is-closing");
      }
      current.classList.toggle("is-closing", Boolean(closing));
      current.setAttribute("data-rui-view-key", key);
      const nextScroll = current.querySelector(".uc-remote-ui__detail-body,.uc-remote-ui__menu");
      if (nextScroll) nextScroll.scrollTop = scroll;
      if (focus) {
        const selector = focus.range
          ? `[data-rui-range="${CSS.escape(focus.range)}"][data-rui-entity="${CSS.escape(focus.entity)}"]`
          : focus.name ? `[name="${CSS.escape(focus.name)}"]` : "";
        const nextFocus = selector ? current.querySelector(selector) : null;
        if (nextFocus) {
          nextFocus.focus({ preventScroll: true });
          if (Number.isInteger(focus.selectionStart) && typeof nextFocus.setSelectionRange === "function") {
            nextFocus.setSelectionRange(focus.selectionStart, focus.selectionEnd);
          }
        }
      }
      if (host === this.root.querySelector("[data-rui-detail-host]")) this.view.detailKey = key;
      else this.view.sectionKey = key;
    }

    statusBar() {
      const settings = this.model.state.settings || {};
      const battery = clamp(settings.battery_level ?? 82, 0, 100);
      const charging = Boolean(settings.charging);
      const showPercentage = Boolean(settings.show_battery_percentage || charging);
      const profileName = entityName(this.model, this.model.state.profile, "Profile");
      const profiles = this.model.state.profiles || [];
      return `<header class="uc-remote-ui__status">
        <button type="button" class="uc-remote-ui__status-time-button" data-rui-action="scroll-top" title="Scroll to top"><span class="uc-remote-ui__status-time" data-rui-clock></span></button>
        <div class="uc-remote-ui__status-actions">
          <span class="uc-remote-ui__status-wifi" title="Wi-Fi">${icon("wifi")}</span>
          <button type="button" class="uc-remote-ui__status-button" data-rui-action="charging" title="Battery"><span class="uc-remote-ui__status-battery">${showPercentage ? `<span>${battery}</span>` : ""}${charging ? icon("bolt") : `<span class="uc-remote-ui__battery-vertical"><span style="height:${battery}%"></span></span>`}</span></button>
          <button type="button" class="uc-remote-ui__status-button uc-remote-ui__status-button--profile" data-rui-action="profile" title="${html(profiles.length > 1 ? `Profile: ${profileName} — switch profile` : `Profile: ${profileName}`)}">${html(profileName.slice(0, 1).toUpperCase())}</button>
        </div>
      </header>`;
    }

    basePage() {
      const screen = this.baseScreen();
      const items = this.baseItems();
      const screens = this.model.state.screens || [];
      const title = screen?.title || entityName(this.model, this.model.state.profile, "Remote");
      const background = this.model.backgroundUrl ? this.model.backgroundUrl(screen) : "";
      const activity = this.pageActivity();
      const mediaEntity = this.pageMedia(activity);
      const hasActivity = Boolean(activity && this.model.state.settings?.enable_activity_bar !== false);
      const hasMedia = Boolean(hasActivity && mediaEntity && media(mediaEntity).art);
      const list = items.length ? items.map((item, index) => this.itemMarkup(item, index)).join("") : `<div class="uc-remote-ui__empty">Press and hold the Home button or use the Web Configurator to configure the page</div>`;
      const dots = screens.length > 1 ? `<div class="uc-remote-ui__page-indicator">${screens.map((page, index) => `<button type="button" class="${index === this.model.state.screenIndex ? "is-active" : ""}" data-rui-screen="${index}" title="${html(page.title)}"></button>`).join("")}</div>` : "";
      return `<section class="uc-remote-ui__page">
        <div class="uc-remote-ui__page-stage">
          <div class="uc-remote-ui__page-scroll" data-rui-page-scroll data-rui-page-list>
            <header class="uc-remote-ui__page-header ${hasActivity ? "has-activity" : ""} ${hasMedia ? "has-media" : ""}" style="--rui-page-bg:${background ? `url('${html(background)}')` : "none"}">
              <h1 class="uc-remote-ui__page-title">${html(title)}</h1>
              ${this.activityHeaderMarkup(activity)}
            </header>
            <div class="uc-remote-ui__list">${list}</div>
          </div>
          ${dots}
        </div>
      </section>`;
    }

    itemMarkup(item, index) {
      if (item.kind === "group") return this.groupMarkup(item, index);
      const entity = item.data;
      const type = typeOf(entity);
      const active = isActive(entity);
      const selected = index === this.model.state.selectedIndex;
      const id = idOf(this.model, entity);
      let command = "";
      let params = {};
      if (type === "button") command = commandId("button", "push");
      else if (type === "switch") command = commandId("switch", "toggle");
      else if (type === "light") command = commandId("light", "toggle");
      else if (type === "cover") command = commandId("cover", active ? "close" : "open");
      else if (type === "media_player") command = commandId("media_player", "play_pause");
      else if (type === "remote") command = "remote.toggle";
      else if (type === "macro") command = commandId("macro", "start");
      else if (type === "activity" && !active) command = commandId("activity", "on");
      const iconContent = entityIcon(this.model, entity);
      const iconNode = command
        ? `<button type="button" class="uc-remote-ui__entity-icon-button ${active ? "is-on" : ""}" data-rui-command-entity="${html(id)}" data-rui-command="${html(command)}" data-rui-params="${html(JSON.stringify(params))}" title="Control ${html(entityName(this.model, entity, id))}">${iconContent}</button>`
        : `<span class="uc-remote-ui__entity-icon-button ${active ? "is-on" : ""}">${iconContent}</span>`;
      return `<article class="uc-remote-ui__entity ${active ? "is-on" : ""} ${selected ? "is-selected" : ""} ${item.nested ? "is-nested" : ""}" data-rui-item="${index}">
        ${iconNode}
        <div class="uc-remote-ui__entity-copy"><strong class="uc-remote-ui__entity-name">${html(entityName(this.model, entity, id))}</strong><small class="uc-remote-ui__entity-state">${html(stateLabel(entity))}</small></div>
      </article>`;
    }

    groupMarkup(item, index) {
      const group = item.data;
      const id = String(group.group_id || group.id || item.id || "");
      const expanded = this.model.state.expandedGroups.has(id);
      const members = this.model.groupMembers ? this.model.groupMembers(group) : [];
      const active = members.some(isActive);
      return `<article class="uc-remote-ui__group ${expanded ? "is-open" : ""} ${index === this.model.state.selectedIndex ? "is-selected" : ""}" data-rui-group-expand="${html(id)}">
        <button type="button" class="uc-remote-ui__group-arrow" data-rui-group-expand="${html(id)}" aria-label="${expanded ? "Collapse" : "Expand"}">${icon("up")}</button>
        <div class="uc-remote-ui__entity-copy"><strong class="uc-remote-ui__entity-name">${html(entityName(this.model, group, "Group"))}</strong><small class="uc-remote-ui__entity-state">${members.length} ${members.length === 1 ? "entity" : "entities"}</small></div>
        <button type="button" class="uc-remote-ui__group-switch ${active ? "is-on" : ""}" data-rui-group-power="${html(id)}" aria-label="Toggle group"><span></span></button>
      </article>`;
    }

    detailMarkup(entity) {
      const type = typeOf(entity);
      const title = entityName(this.model, entity, idOf(this.model, entity));
      let body = "";
      if (type === "activity") body = this.activityMarkup(entity);
      else if (type === "remote") body = this.remoteMarkup(entity);
      else if (type === "media_player") body = this.mediaMarkup(entity);
      else if (type === "light") body = this.lightMarkup(entity);
      else if (type === "cover") body = this.coverMarkup(entity);
      else if (type === "climate") body = this.climateMarkup(entity);
      else if (type === "switch") body = this.squareMarkup(entity, "switch");
      else if (type === "button") body = this.squareMarkup(entity, "button");
      else if (type === "macro") body = this.squareMarkup(entity, "macro");
      else if (type === "select") body = this.selectMarkup(entity);
      else if (type === "sensor") body = this.sensorMarkup(entity);
      else body = this.genericMarkup(entity);
      return `<section class="uc-remote-ui__detail ${this.model.state.activityOverlayClosing || this.model.state.entityControlClosing ? "is-closing" : ""}" data-rui-detail>
        <header class="uc-remote-ui__detail-title">${entityIcon(this.model, entity, "uc-remote-ui__detail-title-icon")}<div class="uc-remote-ui__detail-title-copy"><strong>${html(title)}</strong></div><div class="uc-remote-ui__detail-status"><span>${clamp(this.model.state.settings.battery_level ?? 82,0,100)}</span><span class="uc-remote-ui__battery-vertical"><span style="height:${clamp(this.model.state.settings.battery_level ?? 82,0,100)}%"></span></span></div><button type="button" class="uc-remote-ui__close" data-rui-action="close-detail" title="Close">${icon("close")}</button></header>
        <div class="uc-remote-ui__detail-body">${body}</div>
      </section>`;
    }

    activityMarkup(activity) {
      const pages = this.model.entityScreens ? this.model.entityScreens(activity) : [];
      const index = clamp(this.model.state.activityOverlayIndex, 0, Math.max(0, pages.length - 1));
      const page = pages[index] || null;
      const pageData = page?.page || {};
      const widgets = Array.isArray(pageData.items) ? pageData.items : [];
      const grid = pageData.grid || { width: 4, height: 6 };
      let content = "";
      if (widgets.length) {
        content = `<div class="uc-remote-ui__activity-grid" style="--rui-grid-w:${number(grid.width,4)};--rui-grid-h:${number(grid.height,6)}">${widgets.map((widget, widgetIndex) => this.activityWidgetMarkup(widget, widgetIndex)).join("")}</div>`;
      } else {
        const included = activity.options?.included_entities || activity.included_entities || activity.entities || [];
        content = `<div class="uc-remote-ui__option-list">${included.map((entity) => `<button type="button" class="uc-remote-ui__option" data-rui-open-entity="${html(idOf(this.model, entity))}"><span>${html(entityName(this.model, entity, idOf(this.model, entity)))}</span>${icon("right")}</button>`).join("") || `<div class="uc-remote-ui__empty">Empty activity page</div>`}</div>`;
      }
      const dots = pages.length > 1 ? `<div class="uc-remote-ui__detail-tabs">${pages.map((value, pageIndex) => `<button type="button" class="${pageIndex === index ? "is-active" : ""}" data-rui-activity-page="${pageIndex}" title="${html(value.title)}"></button>`).join("")}</div>` : "";
      return `${content}${dots}<div class="uc-remote-ui__button-row"><button type="button" class="uc-remote-ui__soft-button uc-remote-ui__soft-button--danger" data-rui-activity-power="off">${icon("power")} Turn off</button></div>`;
    }

    activityWidgetMarkup(widget, index) {
      const type = String(widget?.type || "button").toLowerCase();
      const location = widget.location || {};
      const size = widget.size || {};
      const style = `grid-column:${number(location.x,0)+1}/span ${number(size.width,1)};grid-row:${number(location.y,0)+1}/span ${number(size.height,1)};`;
      if (type === "media_player") {
        const entity = this.model.state.entities.get(String(widget.media_player_id || ""));
        return `<div class="uc-remote-ui__activity-widget is-media" style="${style}">${entity ? this.mediaMarkup(entity, true) : ""}</div>`;
      }
      if (type === "sensor") {
        const id = String(widget.sensor?.sensor_id || widget.sensor_id || "");
        const entity = this.model.state.entities.get(id);
        return `<div class="uc-remote-ui__activity-widget" style="${style}">${entity ? `<strong>${html(attrs(entity).value ?? attrs(entity).state ?? "—")}${html(attrs(entity).unit || "")}</strong>` : "—"}</div>`;
      }
      if (type === "select") {
        const id = String(widget.select?.select_id || widget.select_id || "");
        const entity = this.model.state.entities.get(id);
        const options = attrs(entity).options || entity?.options?.options || [];
        return `<div class="uc-remote-ui__activity-widget" style="${style}"><select class="uc-remote-ui__select" data-rui-select-entity="${html(id)}">${options.map((option) => `<option ${String(option) === String(attrs(entity).current_option || attrs(entity).state) ? "selected" : ""}>${html(option)}</option>`).join("")}</select></div>`;
      }
      const command = widget.command || {};
      return `<button type="button" class="uc-remote-ui__activity-widget is-button" style="${style}" data-rui-command-entity="${html(command.entity_id || "")}" data-rui-command="${html(command.cmd_id || "")}" data-rui-params="${html(JSON.stringify(command.params || {}))}">${widget.icon ? icon(iconName({ icon: widget.icon })) : ""}<span>${html(widget.text || `Button ${index + 1}`)}</span></button>`;
    }

    remoteMarkup(entity) {
      const commands = entity.options?.simple_commands || entity.simple_commands || ["POWER", "HOME", "BACK", "MENU", "UP", "DOWN", "LEFT", "RIGHT", "OK", "PLAY", "PAUSE", "NEXT", "PREVIOUS", "VOLUME_UP", "VOLUME_DOWN", "MUTE"];
      return `<div class="uc-remote-ui__remote-grid">${commands.map((command) => `<button type="button" class="uc-remote-ui__remote-key ${String(command).length > 12 ? "is-wide" : ""}" data-rui-command-entity="${html(idOf(this.model, entity))}" data-rui-command="remote.send_cmd" data-rui-params="${html(JSON.stringify({ command }))}">${html(String(command).replaceAll("_", " "))}</button>`).join("")}</div>`;
    }

    mediaMarkup(entity, compact = false) {
      const value = media(entity);
      const id = idOf(this.model, entity);
      const duration = Math.max(1, value.duration);
      const position = clamp(value.position, 0, duration);
      const normalizedVolume = value.volume <= 1 ? value.volume * 100 : value.volume;
      const art = value.art.startsWith("/")
        ? `${this.model.sessionBase || ""}${value.art}`
        : (/^https?:|^data:|^blob:/i.test(value.art) ? value.art : resourceUrl(this.model, "Icon", value.art));
      const image = art ? `<img src="${html(art)}" alt="">` : icon("music");
      const sourceOptions = value.sources.length ? `<select class="uc-remote-ui__select" data-rui-media-source="${html(id)}">${value.sources.map((source) => `<option ${source === value.source ? "selected" : ""}>${html(source)}</option>`).join("")}</select>` : "";
      const soundOptions = value.soundModes.length ? `<select class="uc-remote-ui__select" data-rui-media-sound="${html(id)}">${value.soundModes.map((mode) => `<option ${mode === value.soundMode ? "selected" : ""}>${html(mode)}</option>`).join("")}</select>` : "";
      return `<div class="uc-remote-ui__media" style="--rui-media-art:${art ? `url('${html(art)}')` : "none"}">
        <div class="uc-remote-ui__media-bg"></div>
        <button type="button" class="uc-remote-ui__media-art" data-rui-media-browser="${html(id)}" title="Browse media">${image}</button>
        <div class="uc-remote-ui__media-copy"><strong>${html(value.title)}</strong><span>${html([value.artist, value.album].filter(Boolean).join(" · "))}</span></div>
        <label class="uc-remote-ui__media-progress"><span>${formatTime(position)}</span><input type="range" min="0" max="${duration}" value="${position}" data-rui-range="media-seek" data-rui-entity="${html(id)}"><span>${formatTime(duration)}</span></label>
        <div class="uc-remote-ui__media-controls"><button type="button" class="uc-remote-ui__media-control" data-rui-command-entity="${html(id)}" data-rui-command="${commandId("media_player","previous")}">${icon("previous")}</button><button type="button" class="uc-remote-ui__media-control is-primary" data-rui-command-entity="${html(id)}" data-rui-command="${commandId("media_player","play_pause")}">${icon(value.state === "playing" ? "pause" : "play")}</button><button type="button" class="uc-remote-ui__media-control" data-rui-command-entity="${html(id)}" data-rui-command="${commandId("media_player","next")}">${icon("next")}</button><button type="button" class="uc-remote-ui__media-control" data-rui-command-entity="${html(id)}" data-rui-command="${commandId("media_player","mute")}">${icon(value.muted ? "mute" : "volume")}</button></div>
        ${compact ? "" : `<div class="uc-remote-ui__media-options">${sourceOptions || `<label><span class="uc-remote-ui__meta-label">Volume</span><input class="uc-remote-ui__range" type="range" min="0" max="100" value="${normalizedVolume}" data-rui-range="media-volume" data-rui-entity="${html(id)}"></label>`}${soundOptions || `<button type="button" class="uc-remote-ui__soft-button" data-rui-media-browser="${html(id)}">${icon("music")} Browse</button>`}</div>`}
      </div>`;
    }

    lightMarkup(entity) {
      const id = idOf(this.model, entity);
      const level = Math.round(brightness(entity));
      const a = attrs(entity);
      const temp = number(a.color_temperature, 3200);
      const min = number(a.min_color_temperature, 2200);
      const max = number(a.max_color_temperature, 6500);
      const color = this.lightColor(entity);
      const tabs = ["Power", "Brightness", "Color"];
      let body = "";
      if (this.local.detailTab === 0) {
        body = `<div class="uc-remote-ui__square-view"><strong class="uc-remote-ui__square-title">${isActive(entity) ? "On" : "Off"}</strong><button type="button" class="uc-remote-ui__square-control ${isActive(entity) ? "is-on" : ""}" data-rui-command-entity="${html(id)}" data-rui-command="${commandId("light","toggle")}"></button></div>`;
      } else if (this.local.detailTab === 1) {
        body = `<div class="uc-remote-ui__light"><div class="uc-remote-ui__light-value"><strong>${level}%</strong><span>brightness</span></div><div class="uc-remote-ui__vertical-sliders"><label class="uc-remote-ui__vslider"><span class="uc-remote-ui__meta-label">Brightness</span><input type="range" min="0" max="100" value="${level}" data-rui-range="light-brightness" data-rui-entity="${html(id)}"><output>${level}%</output></label><label class="uc-remote-ui__vslider is-warm"><span class="uc-remote-ui__meta-label">Temperature</span><input type="range" min="${min}" max="${max}" value="${temp}" data-rui-range="light-temperature" data-rui-entity="${html(id)}"><output>${temp} K</output></label></div></div>`;
      } else {
        body = `<div class="uc-remote-ui__light"><div class="uc-remote-ui__color-wheel" style="--rui-current-color:${html(color)}"><input type="color" value="${html(color)}" data-rui-color="${html(id)}"></div><label><span class="uc-remote-ui__meta-label">Saturation</span><input class="uc-remote-ui__range" type="range" min="0" max="100" value="${clamp(a.saturation ?? a.hs_color?.[1] ?? 50,0,100)}" data-rui-range="light-saturation" data-rui-entity="${html(id)}"></label></div>`;
      }
      return `${body}<div class="uc-remote-ui__detail-tabs">${tabs.map((tab,index) => `<button type="button" class="${index === this.local.detailTab ? "is-active" : ""}" data-rui-detail-tab="${index}" title="${tab}"></button>`).join("")}</div>`;
    }

    lightColor(entity) {
      const a = attrs(entity);
      const hs = a.hs_color || [a.hue ?? 32, a.saturation ?? 48];
      const h = ((number(hs[0]) % 360) + 360) % 360;
      const s = clamp(number(hs[1], 50), 0, 100) / 100;
      const l = 0.5;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs((h / 60) % 2 - 1));
      const m = l - c / 2;
      let rgb = [0,0,0];
      if (h < 60) rgb = [c,x,0]; else if (h < 120) rgb = [x,c,0]; else if (h < 180) rgb = [0,c,x]; else if (h < 240) rgb = [0,x,c]; else if (h < 300) rgb = [x,0,c]; else rgb = [c,0,x];
      return `#${rgb.map((v) => Math.round((v+m)*255).toString(16).padStart(2,"0")).join("")}`;
    }

    coverMarkup(entity) {
      const id = idOf(this.model, entity);
      const position = Math.round(coverPosition(entity));
      return `<div class="uc-remote-ui__cover"><strong class="uc-remote-ui__cover-state">${html(entityState(entity) || "stopped")}</strong><div class="uc-remote-ui__cover-visual"><div class="uc-remote-ui__cover-mask" style="height:${100-position}%"></div>${icon("cover")}<input type="range" min="0" max="100" value="${position}" data-rui-range="cover-position" data-rui-entity="${html(id)}"><output class="uc-remote-ui__cover-position">${position}%</output></div><div class="uc-remote-ui__cover-actions"><button type="button" class="uc-remote-ui__soft-button" data-rui-command-entity="${html(id)}" data-rui-command="${commandId("cover","open")}">${icon("up")} Open</button><button type="button" class="uc-remote-ui__soft-button" data-rui-command-entity="${html(id)}" data-rui-command="${commandId("cover","stop")}">${icon("stop")}</button><button type="button" class="uc-remote-ui__soft-button" data-rui-command-entity="${html(id)}" data-rui-command="${commandId("cover","close")}">${icon("down")} Close</button></div></div>`;
    }

    climateMarkup(entity) {
      const id = idOf(this.model, entity);
      const data = climate(entity);
      const previous = (data.target - data.step).toFixed(1).replace(".0", "");
      const next = (data.target + data.step).toFixed(1).replace(".0", "");
      return `<div class="uc-remote-ui__climate"><button type="button" class="uc-remote-ui__climate-step" data-rui-climate-step="${data.step}" data-rui-entity="${html(id)}">${icon("up")}</button><div class="uc-remote-ui__climate-wheel"><span>${next}${html(data.unit)}</span><strong>${data.target.toFixed(1).replace(".0", "")}${html(data.unit)}</strong><span>${previous}${html(data.unit)}</span></div><button type="button" class="uc-remote-ui__climate-step is-down" data-rui-climate-step="-${data.step}" data-rui-entity="${html(id)}">${icon("down")}</button><div class="uc-remote-ui__climate-footer"><div class="uc-remote-ui__climate-metric"><span class="uc-remote-ui__meta-label">Current</span><strong>${data.current.toFixed(1)}${html(data.unit)}</strong></div><label><span class="uc-remote-ui__meta-label">Mode</span><select class="uc-remote-ui__select" data-rui-climate-mode="${html(id)}">${data.modes.map((mode) => `<option ${String(mode).toLowerCase() === data.mode ? "selected" : ""}>${html(mode)}</option>`).join("")}</select></label></div></div>`;
    }

    squareMarkup(entity, type) {
      const id = idOf(this.model, entity);
      const active = isActive(entity);
      const label = type === "button" ? "Push" : type === "macro" ? String(attrs(entity).state || "Run") : active ? "On" : "Off";
      const command = type === "button" ? commandId("button","push") : type === "macro" ? commandId("macro","start") : commandId("switch","toggle");
      const progress = type === "macro" ? clamp(attrs(entity).progress ?? 0,0,100) : null;
      return `<div class="uc-remote-ui__square-view"><strong class="uc-remote-ui__square-title">${html(label)}</strong><button type="button" class="uc-remote-ui__square-control ${active ? "is-on" : ""}" data-rui-command-entity="${html(id)}" data-rui-command="${command}">${progress !== null ? `<span class="uc-remote-ui__square-progress"><span style="width:${progress}%"></span></span>` : ""}</button></div>`;
    }

    selectMarkup(entity) {
      const id = idOf(this.model, entity);
      const options = attrs(entity).options || entity.options?.options || [];
      const current = String(attrs(entity).current_option || attrs(entity).state || "");
      return `<div class="uc-remote-ui__option-list">${options.map((option) => `<button type="button" class="uc-remote-ui__option ${String(option) === current ? "is-active" : ""}" data-rui-select-option="${html(option)}" data-rui-entity="${html(id)}"><span>${html(option)}</span><span class="uc-remote-ui__option-check"></span></button>`).join("")}</div>`;
    }

    sensorMarkup(entity) {
      const a = attrs(entity);
      const value = number(a.value ?? a.state, 0);
      const unit = String(a.unit || "");
      const history = this.local.sensorHistory.get(idOf(this.model, entity)) || [value];
      const min = Math.min(...history);
      const max = Math.max(...history);
      const range = Math.max(.001, max - min);
      const bars = history.map((sample) => `<span style="height:${20 + ((sample-min)/range)*80}%"></span>`).join("");
      return `<div class="uc-remote-ui__sensor"><span class="uc-remote-ui__sensor-icon">${icon(iconName(entity))}</span><strong class="uc-remote-ui__sensor-value">${html(Number.isInteger(value) ? value : value.toFixed(1))}</strong><span class="uc-remote-ui__sensor-unit">${html(unit)}</span><div class="uc-remote-ui__sparkline">${bars}</div></div>`;
    }

    genericMarkup(entity) {
      return `<div class="uc-remote-ui__sensor">${icon(iconName(entity), "uc-remote-ui__sensor-icon")}<strong class="uc-remote-ui__big-value">${html(stateLabel(entity) || "Ready")}</strong></div>`;
    }

    groupDetailMarkup() {
      const group = this.model.state.groups.get(this.local.groupDetailId);
      if (!group) { this.local.groupDetailId = ""; return ""; }
      const members = this.model.groupMembers ? this.model.groupMembers(group) : [];
      return `<section class="uc-remote-ui__detail"><header class="uc-remote-ui__detail-title">${entityIcon(this.model,{...group,entity_type:"group"},"uc-remote-ui__detail-title-icon")}<div class="uc-remote-ui__detail-title-copy"><strong>${html(entityName(this.model,group,"Group"))}</strong><small>${members.length} entities</small></div><button type="button" class="uc-remote-ui__close" data-rui-action="close-group">${icon("close")}</button></header><div class="uc-remote-ui__detail-body"><div class="uc-remote-ui__group-detail">${members.map((entity) => this.itemMarkup({kind:"entity",data:entity},-1)).join("")}</div><div class="uc-remote-ui__button-row"><button type="button" class="uc-remote-ui__soft-button" data-rui-group-set="on" data-rui-group="${html(this.local.groupDetailId)}">All on</button><button type="button" class="uc-remote-ui__soft-button" data-rui-group-set="off" data-rui-group="${html(this.local.groupDetailId)}">All off</button></div></div></section>`;
    }

    sectionMarkup() {
      if (this.local.section === "profile") return this.profileMarkup();
      if (this.local.section === "media-browser") return this.mediaBrowserMarkup();
      return "";
    }

    sectionHeader(title, backAction = "home") {
      return `<header class="uc-remote-ui__section-title"><button type="button" class="uc-remote-ui__close" data-rui-action="${backAction}">${icon("back")}</button><strong>${html(title)}</strong><span></span></header>`;
    }

    profileMarkup() {
      const current = this.model.state.profile;
      const currentId = idOf(this.model, current);
      const profiles = (this.model.state.profiles || []).length ? this.model.state.profiles : (current ? [current] : []);
      const rows = profiles.map((profile) => {
        const id = idOf(this.model, profile);
        const name = entityName(this.model, profile, "Profile");
        const active = id === currentId;
        return `<button type="button" class="uc-remote-ui__profile-card uc-remote-ui__profile-option ${active ? "is-active" : ""}" data-rui-profile="${html(id)}"><span class="uc-remote-ui__profile-avatar">${html(name.slice(0, 1).toUpperCase())}</span><div><strong>${html(name)}</strong><small class="uc-remote-ui__entity-state">${active ? "active profile" : "switch to this profile"}</small></div>${active ? icon("check") : icon("right")}</button>`;
      }).join("");
      return `<section class="uc-remote-ui__detail">${this.sectionHeader("Profiles")}<div class="uc-remote-ui__menu">${rows}</div></section>`;
    }

    mediaBrowserMarkup() {
      const id = this.local.mediaBrowserEntityId;
      const entity = this.model.state.entities.get(id);
      const items = this.local.mediaItems;
      return `<section class="uc-remote-ui__detail">${this.sectionHeader("Media", "close-media-browser")}<div class="uc-remote-ui__menu">${this.local.mediaLoading ? `<div class="uc-remote-ui__empty">Loading media…</div>` : items.map((item,index) => { const art = item.image_url || item.artwork_url || ""; const url = art.startsWith("/") ? `${this.model.sessionBase || ""}${art}` : art; return `<button type="button" class="uc-remote-ui__menu-item" data-rui-media-play="${index}"><span class="uc-remote-ui__menu-item-icon">${url ? `<img src="${html(url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : icon("film")}</span><span class="uc-remote-ui__menu-item-copy"><strong>${html(item.title || "Media")}</strong><small>${html(item.artist || item.album || "")}</small></span>${icon("play")}</button>`; }).join("") || `<div class="uc-remote-ui__empty">No media found</div>`}</div></section>`;
    }

    systemOverlays() {
      let value = "";
      if (this.local.powerOpen) value += `<div class="uc-remote-ui__overlay" data-rui-overlay="power"><div class="uc-remote-ui__sheet"><h2>Power</h2><div class="uc-remote-ui__power-options"><button type="button" class="uc-remote-ui__power-option" data-rui-power-option="sleep">${icon("sleep")}<span>Sleep</span></button><button type="button" class="uc-remote-ui__power-option" data-rui-power-option="restart">${icon("restart")}<span>Restart UI</span></button><button type="button" class="uc-remote-ui__power-option" data-rui-power-option="off">${icon("power")}<span>Power off</span></button></div></div></div>`;
      if (this.local.voiceOpen) value += `<div class="uc-remote-ui__voice" data-rui-overlay="voice"><div class="uc-remote-ui__voice-bars"><span></span><span></span><span></span></div><strong>Listening…</strong><small>Voice assistant</small></div>`;
      if (this.local.chargingOpen) value += `<button type="button" class="uc-remote-ui__charging" data-rui-action="close-charging" data-rui-overlay="charging" aria-label="Close charging screen"><span class="uc-remote-ui__clock"><i class="uc-remote-ui__clock-dot is-12"></i><i class="uc-remote-ui__clock-dot is-3"></i><i class="uc-remote-ui__clock-dot is-6"></i><i class="uc-remote-ui__clock-dot is-9"></i><i class="uc-remote-ui__clock-hand is-hour" data-rui-clock-hour></i><i class="uc-remote-ui__clock-hand is-minute" data-rui-clock-minute></i><i class="uc-remote-ui__clock-hand is-second" data-rui-clock-second></i><i class="uc-remote-ui__clock-center"></i></span><span class="uc-remote-ui__charge-indicator">${icon("bolt")}<strong data-rui-charge-level>${clamp(this.model.state.settings.battery_level ?? 82,0,100)}%</strong><span>${this.model.state.settings.charging ? "Charging" : "Battery"}</span></span></button>`;
      if (this.local.volume) value += `<div class="uc-remote-ui__volume"><span>${icon(this.local.volume.muted ? "mute" : "volume")}</span><div class="uc-remote-ui__volume-meter"><span style="width:${clamp(this.local.volume.value,0,100)}%"></span></div><strong>${Math.round(this.local.volume.value)}</strong></div>`;
      return value;
    }

    toastMarkup() {
      return this.local.toast ? `<div class="uc-remote-ui__toast ${this.local.toast.error ? "is-error" : ""}">${html(this.local.toast.message)}</div>` : "";
    }

    updateClock() {
      const node = this.root.querySelector("[data-rui-clock]");
      if (!node) return;
      const now = new Date();
      node.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const hours = (now.getHours() % 12) + now.getMinutes() / 60;
      const minutes = now.getMinutes() + now.getSeconds() / 60;
      const seconds = now.getSeconds();
      const hour = this.root.querySelector("[data-rui-clock-hour]");
      const minute = this.root.querySelector("[data-rui-clock-minute]");
      const second = this.root.querySelector("[data-rui-clock-second]");
      if (hour) hour.style.transform = `translateX(-50%) rotate(${hours * 30}deg)`;
      if (minute) minute.style.transform = `translateX(-50%) rotate(${minutes * 6}deg)`;
      if (second) second.style.transform = `translateX(-50%) rotate(${seconds * 6}deg)`;
    }

    showToast(message, error = false) {
      clearTimeout(this.local.toastTimer);
      this.local.toast = { message: String(message), error };
      this.render();
      this.local.toastTimer = setTimeout(() => { this.local.toast = null; this.render(); }, 2100);
    }

    async send(entityId, command, params = {}) {
      if (!entityId || !command) return;
      try {
        await this.actions.command?.(entityId, command, params);
        await this.actions.refresh?.();
      } catch (error) {
        this.showToast(error?.message || String(error), true);
      }
    }

    async onClick(event) {
      const target = event.target.closest("button,[data-rui-item],[data-rui-group-detail],[data-rui-group-expand]");
      if (!target || !this.root.contains(target)) return;
      const action = target.dataset.ruiAction;
      if (action) {
        event.preventDefault();
        if (action === "scroll-top") this.root.querySelector("[data-rui-page-scroll]")?.scrollTo({ top: 0, behavior: "smooth" });
        else if (action === "profile") { this.local.section = "profile"; this.render(); }
        else if (action === "charging") { this.local.chargingOpen = true; this.render(); }
        else if (action === "close-charging") { this.local.chargingOpen = false; this.render(); }
        else if (action === "home") this.goHome();
        else if (action === "close-group") { this.local.groupDetailId = ""; this.render(); }
        else if (action === "close-media-browser") { this.local.section = "home"; this.local.mediaBrowserEntityId = ""; this.render(); }
        else if (action === "close-detail") this.actions.closeDetail?.();
        return;
      }

      if (target.dataset.ruiProfile !== undefined) {
        this.local.section = "home";
        await this.actions.switchProfile?.(target.dataset.ruiProfile);
        this.render();
        return;
      }
      if (target.dataset.ruiScreen !== undefined) {
        this.actions.setScreen?.(Number(target.dataset.ruiScreen));
        return;
      }
      if (target.dataset.ruiItem !== undefined) {
        const index = Number(target.dataset.ruiItem);
        if (index >= 0) await this.actions.activateItem?.(index);
        return;
      }
      if (target.dataset.ruiQuick) {
        event.stopPropagation();
        const id = target.dataset.ruiEntity;
        const entity = this.model.state.entities.get(id);
        const type = typeOf(entity);
        await this.send(id, target.dataset.ruiQuick === "push" ? commandId("button","push") : commandId(type,"toggle"));
        return;
      }
      if (target.dataset.ruiGroupExpand) {
        event.stopPropagation();
        this.actions.toggleGroup?.(target.dataset.ruiGroupExpand);
        return;
      }
      if (target.dataset.ruiGroupDetail) {
        this.local.groupDetailId = target.dataset.ruiGroupDetail;
        this.render();
        return;
      }
      if (target.dataset.ruiGroupPower) {
        event.stopPropagation();
        await this.actions.toggleGroupPower?.(target.dataset.ruiGroupPower);
        return;
      }
      if (target.dataset.ruiGroupSet) {
        await this.actions.setGroupPower?.(target.dataset.ruiGroup, target.dataset.ruiGroupSet === "on");
        return;
      }
      if (target.dataset.ruiDetailTab !== undefined) {
        this.local.detailTab = Number(target.dataset.ruiDetailTab);
        this.render();
        return;
      }
      if (target.dataset.ruiActivityPage !== undefined) {
        this.actions.setActivityPage?.(Number(target.dataset.ruiActivityPage));
        return;
      }
      if (target.dataset.ruiActivityPower) {
        await this.actions.activityPower?.(target.dataset.ruiActivityPower);
        return;
      }
      if (target.dataset.ruiCommand) {
        let params = {};
        try { params = JSON.parse(target.dataset.ruiParams || "{}"); } catch {}
        await this.send(target.dataset.ruiCommandEntity, target.dataset.ruiCommand, params);
        return;
      }
      if (target.dataset.ruiOpenEntity) {
        await this.actions.openEntityById?.(target.dataset.ruiOpenEntity);
        return;
      }
      if (target.dataset.ruiSelectOption !== undefined) {
        await this.send(target.dataset.ruiEntity, commandId("select","option"), { option: target.dataset.ruiSelectOption });
        return;
      }
      if (target.dataset.ruiClimateStep) {
        const entity = this.model.state.entities.get(target.dataset.ruiEntity);
        const data = climate(entity);
        await this.send(target.dataset.ruiEntity, commandId("climate","temperature"), { temperature: data.target + number(target.dataset.ruiClimateStep) });
        return;
      }
      if (target.dataset.ruiMediaBrowser) {
        await this.openMediaBrowser(target.dataset.ruiMediaBrowser);
        return;
      }
      if (target.dataset.ruiMediaPlay !== undefined) {
        const item = this.local.mediaItems[Number(target.dataset.ruiMediaPlay)];
        if (item) {
          await this.send(this.local.mediaBrowserEntityId, "media_player.play_media", { media_id: item.media_id, media_type: item.media_type || "video" });
          this.local.section = "home";
          this.render();
        }
        return;
      }
      if (target.dataset.ruiPowerOption) {
        const option = target.dataset.ruiPowerOption;
        this.local.powerOpen = false;
        if (option === "restart") { this.showToast("Remote UI restarted"); this.goHome(); }
        else if (option === "sleep") { this.local.chargingOpen = true; this.render(); }
        else { this.local.chargingOpen = true; }
      }
    }

    async onChange(event) {
      const target = event.target;
      if (target.dataset.ruiSelectEntity) await this.send(target.dataset.ruiSelectEntity, commandId("select","option"), { option: target.value });
      else if (target.dataset.ruiMediaSource) await this.send(target.dataset.ruiMediaSource, commandId("media_player","source"), { source: target.value });
      else if (target.dataset.ruiMediaSound) await this.send(target.dataset.ruiMediaSound, commandId("media_player","sound"), { mode: target.value });
      else if (target.dataset.ruiClimateMode) await this.send(target.dataset.ruiClimateMode, commandId("climate","mode"), { mode: target.value });
      else if (target.dataset.ruiColor) {
        const rgb = this.hexToHs(target.value);
        await this.send(target.dataset.ruiColor, commandId("light","color"), rgb);
      } else if (target.dataset.ruiRange) {
        const entity = target.dataset.ruiEntity;
        const value = Number(target.value);
        const kind = target.dataset.ruiRange;
        if (kind === "media-seek") await this.send(entity, commandId("media_player","seek"), { media_position: value });
        else if (kind === "media-volume") await this.send(entity, commandId("media_player","volume"), { volume: value });
        else if (kind === "light-brightness") await this.send(entity, commandId("light","brightness"), { brightness: value });
        else if (kind === "light-temperature") await this.send(entity, commandId("light","temperature"), { temperature: value });
        else if (kind === "light-saturation") {
          const current = this.model.state.entities.get(entity);
          await this.send(entity, commandId("light","color"), { hue: number(attrs(current).hue ?? attrs(current).hs_color?.[0], 32), saturation: value });
        }
        else if (kind === "cover-position") await this.send(entity, commandId("cover","position"), { position: value });
      }
    }

    onInput(event) {
      const target = event.target;
      const output = target.closest("label")?.querySelector("output");
      if (output) output.textContent = target.dataset.ruiRange === "light-temperature" ? `${target.value} K` : `${target.value}%`;
      if (target.dataset.ruiRange === "cover-position") {
        const visual = target.closest(".uc-remote-ui__cover-visual");
        const mask = visual?.querySelector(".uc-remote-ui__cover-mask");
        const position = visual?.querySelector(".uc-remote-ui__cover-position");
        if (mask) mask.style.height = `${100 - Number(target.value)}%`;
        if (position) position.textContent = `${target.value}%`;
      }
    }

    hexToHs(hex) {
      const value = parseInt(String(hex).replace("#", ""), 16);
      const r = ((value >> 16) & 255) / 255;
      const g = ((value >> 8) & 255) / 255;
      const b = (value & 255) / 255;
      const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max-min;
      let h = 0;
      if (delta) {
        if (max === r) h = 60 * (((g-b)/delta) % 6);
        else if (max === g) h = 60 * ((b-r)/delta + 2);
        else h = 60 * ((r-g)/delta + 4);
      }
      if (h < 0) h += 360;
      const s = max === 0 ? 0 : (delta/max)*100;
      return { hue: Math.round(h), saturation: Math.round(s) };
    }

    async openMediaBrowser(entityId) {
      this.local.section = "media-browser";
      this.local.mediaBrowserEntityId = entityId;
      this.local.mediaItems = [];
      this.local.mediaLoading = true;
      this.render();
      try {
        const payload = await this.actions.request?.(`/entities/${encodeURIComponent(entityId)}/media/browse`);
        if (Array.isArray(payload?.items)) this.local.mediaItems = payload.items;
        else if (Array.isArray(payload?.media)) this.local.mediaItems = payload.media;
        else if (payload?.media && typeof payload.media === "object") this.local.mediaItems = Object.values(payload.media);
        else this.local.mediaItems = Array.isArray(payload) ? payload : [];
      } catch (error) {
        this.showToast(error?.message || String(error), true);
      } finally {
        this.local.mediaLoading = false;
        this.render();
      }
    }

    goHome() {
      this.local.section = "home";
      this.local.groupDetailId = "";
      this.local.powerOpen = false;
      this.local.voiceOpen = false;
      this.local.chargingOpen = false;
      this.actions.goHome?.();
      this.render();
    }

    showVolume(entity, value, muted = false) {
      clearTimeout(this.local.volumeTimer);
      this.local.volume = { entityId: idOf(this.model, entity), value, muted };
      this.render();
      this.local.volumeTimer = setTimeout(() => { this.local.volume = null; this.render(); }, 1800);
    }

    async handleHardware(button, press = "short") {
      if (!this.model) return false;
      if (button === "VOICE") {
        if (press === "long" || press === "short") { this.local.voiceOpen = press !== "released"; this.render(); return true; }
      }
      if (button === "POWER" && press === "long") { this.local.powerOpen = true; this.render(); return true; }
      if (press === "long") return false;
      if (this.local.voiceOpen && button !== "VOICE") { this.local.voiceOpen = false; this.render(); return true; }
      if (this.local.powerOpen) {
        if (["BACK","HOME","POWER"].includes(button)) { this.local.powerOpen = false; this.render(); }
        return true;
      }
      if (this.local.chargingOpen) { this.local.chargingOpen = false; this.render(); return true; }
      if (["VOLUME_UP","VOLUME_DOWN","MUTE"].includes(button)) {
        const entity = this.currentMediaPlayer();
        if (!entity) return false;
        const data = media(entity);
        const current = data.volume <= 1 ? data.volume * 100 : data.volume;
        if (button === "MUTE") await this.send(idOf(this.model, entity), commandId("media_player","mute"));
        else await this.send(idOf(this.model, entity), button === "VOLUME_UP" ? "media_player.volume_up" : "media_player.volume_down");
        this.showVolume(entity, clamp(current + (button === "VOLUME_UP" ? 5 : button === "VOLUME_DOWN" ? -5 : 0),0,100), button === "MUTE" ? !data.muted : data.muted);
        return true;
      }
      if (button === "HOME") { this.goHome(); return true; }
      if (button === "BACK") {
        if (this.detailEntity()) { this.actions.closeDetail?.(); return true; }
        if (this.local.groupDetailId) { this.local.groupDetailId = ""; this.render(); return true; }
        if (this.local.section !== "home") { this.local.section = "home"; this.render(); return true; }
        if (this.model.state.screenIndex !== 0) { this.actions.setScreen?.(0); return true; }
        return true;
      }
      if (this.detailEntity()) {
        if (button === "DPAD_LEFT") { this.navigateDetail(-1); return true; }
        if (button === "DPAD_RIGHT") { this.navigateDetail(1); return true; }
        if (button === "DPAD_MIDDLE") { await this.activateDetailPrimary(); return true; }
        if (button === "DPAD_UP" || button === "DPAD_DOWN") return true;
      }
      if (this.local.section !== "home") {
        const menuItems = [...this.root.querySelectorAll(".uc-remote-ui__menu-item:not([disabled]),.uc-remote-ui__profile-option,.uc-remote-ui__media-item")];
        if (button === "DPAD_UP" || button === "DPAD_DOWN") {
          this.local.selectedMenuIndex = (this.local.selectedMenuIndex + (button === "DPAD_DOWN" ? 1 : -1) + Math.max(1,menuItems.length)) % Math.max(1,menuItems.length);
          menuItems.forEach((node,index) => node.classList.toggle("is-selected",index === this.local.selectedMenuIndex));
          menuItems[this.local.selectedMenuIndex]?.scrollIntoView({block:"nearest"});
          return true;
        }
        if (button === "DPAD_MIDDLE") { menuItems[this.local.selectedMenuIndex]?.click(); return true; }
      }
      if (button === "DPAD_LEFT") { this.actions.navigateScreen?.(-1); return true; }
      if (button === "DPAD_RIGHT") { this.actions.navigateScreen?.(1); return true; }
      if (button === "DPAD_UP") { this.actions.moveSelection?.(-1); return true; }
      if (button === "DPAD_DOWN") { this.actions.moveSelection?.(1); return true; }
      if (button === "DPAD_MIDDLE") { await this.actions.activateItem?.(this.model.state.selectedIndex); return true; }
      return false;
    }

    navigateDetail(delta) {
      const detail = this.detailEntity();
      if (!detail) return;
      const type = typeOf(detail);
      if (type === "light") this.local.detailTab = (this.local.detailTab + delta + 3) % 3;
      else if (["activity","remote"].includes(type)) this.actions.navigateActivityPage?.(delta);
      this.render();
    }

    async activateDetailPrimary() {
      const detail = this.detailEntity();
      if (!detail) return;
      const type = typeOf(detail);
      const id = idOf(this.model, detail);
      if (type === "switch") await this.send(id, commandId("switch","toggle"));
      else if (type === "button") await this.send(id, commandId("button","push"));
      else if (type === "macro") await this.send(id, commandId("macro","start"));
      else if (type === "light" && this.local.detailTab === 0) await this.send(id, commandId("light","toggle"));
      else if (type === "media_player") await this.send(id, commandId("media_player","play_pause"));
    }
  }

  window.RemoteUIWeb = Object.freeze({
    create(options) { return new RemoteUIWeb(options); }
  });
})();
