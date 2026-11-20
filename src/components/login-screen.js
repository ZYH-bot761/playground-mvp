/**
 * ============================================================================
 * LoginScreen —— 联机登录页（纯 DOM / 零外部资源）
 * ============================================================================
 * 只负责收集账号密码并把结果交给 onLogin；真正的校验在服务端：
 * 本地走 server/local-room-api.mjs，线上走 netlify/functions/room.mjs（Netlify Blobs）。
 * 分享链接可直接带 ?u=&p=&room= 自动登录，登录成功后由 main.js 收起本页、显示开始页。
 *
 * 生命周期与 StartScreen 保持一致：
 *   const screen = new LoginScreen({ accounts, onLogin });
 *   screen.init(); screen.show(); screen.hide(); screen.dispose();
 * ============================================================================
 */

const STYLE_ID = 'pg-login-styles';

const DEFAULT_OPTIONS = Object.freeze({
  eyebrow: 'PLAYGROUND · ONLINE',
  title: '双人联机大厅',
  subtitle: '两个链接、两台手机，进同一个房间。登录后能在大厅里看到对方，也能一起回家。',
  hint: '演示账号 player1 / player2 · 密码由服务端账号配置校验。',
  accounts: [],
  onLogin: null,
  /** 单人游玩：不登录、不联机，直接进入开始页 */
  onSkip: null,
  /** 分享链接可直接带账号密码进入：?u=player1&p=play1234&room=home */
  defaultUser: '',
  defaultPass: '',
  autoSubmit: false,
});

const STYLE_TEXT = `
.pg-login {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  overflow: hidden;
  isolation: isolate;
  box-sizing: border-box;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  font-family: var(--pg-ui-font, 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif);
  color: #eaf3ff;
  background:
    radial-gradient(60vw 60vw at 8% 92%, rgba(39, 200, 255, 0.18), transparent 70%),
    radial-gradient(54vw 54vw at 92% 12%, rgba(154, 99, 240, 0.2), transparent 70%),
    linear-gradient(160deg, #0a1224 0%, #0d1b30 48%, #080d1c 100%);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.35s ease, visibility 0.35s ease;
}

.pg-login--visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.pg-login__grid {
  position: absolute;
  left: -20%;
  right: -20%;
  bottom: -12%;
  height: 52%;
  z-index: 0;
  pointer-events: none;
  transform: perspective(420px) rotateX(65deg);
  transform-origin: 50% 100%;
  background-image:
    repeating-linear-gradient(90deg, rgba(39, 200, 255, 0.2) 0 2px, transparent 2px 78px),
    repeating-linear-gradient(0deg, rgba(154, 99, 240, 0.18) 0 2px, transparent 2px 78px);
  -webkit-mask-image: linear-gradient(to top, #000 6%, rgba(0, 0, 0, 0.4) 48%, transparent 90%);
  mask-image: linear-gradient(to top, #000 6%, rgba(0, 0, 0, 0.4) 48%, transparent 90%);
}

.pg-login__card {
  position: relative;
  z-index: 2;
  width: min(430px, calc(100vw - 36px));
  padding: 38px 34px 28px;
  border: 1px solid rgba(126, 196, 255, 0.26);
  border-radius: 24px;
  background: linear-gradient(158deg, rgba(15, 23, 40, 0.9) 0%, rgba(9, 15, 28, 0.72) 100%);
  box-shadow:
    0 30px 90px rgba(2, 7, 18, 0.66),
    0 0 0 1px rgba(40, 80, 140, 0.3),
    0 0 80px rgba(39, 200, 255, 0.12),
    inset 0 1px 0 rgba(210, 238, 255, 0.16);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  animation: pg-login-rise 0.55s cubic-bezier(0.2, 0.7, 0.3, 1) both;
  box-sizing: border-box;
}

.pg-login__card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 16%;
  right: 16%;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, #47d2ff, #a98bff, #ffc46b, transparent);
  opacity: 0.9;
}

.pg-login__eyebrow {
  margin: 0 0 10px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.32em;
  text-indent: 0.32em;
  color: #7fd1ff;
}

.pg-login__title {
  margin: 0;
  font-size: clamp(26px, 5vw, 36px);
  font-weight: 800;
  letter-spacing: 0.04em;
  background: linear-gradient(100deg, #ffffff 8%, #a7e7ff 44%, #cbb4ff 78%, #ffd79a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.pg-login__subtitle {
  margin: 12px 0 22px;
  font-size: 13px;
  line-height: 1.8;
  color: #b9cbe6;
}

.pg-login__form { display: grid; gap: 12px; }

.pg-login__field {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: #8fa9ca;
}

.pg-login__field input {
  width: 100%;
  box-sizing: border-box;
  padding: 12px 14px;
  font: inherit;
  font-size: 16px;
  color: #eef7ff;
  background: rgba(6, 12, 24, 0.62);
  border: 1px solid rgba(116, 176, 235, 0.24);
  border-radius: 12px;
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
  -webkit-appearance: none;
}

.pg-login__field input::placeholder { color: #5e7595; }

.pg-login__field input:focus {
  border-color: rgba(98, 208, 255, 0.72);
  box-shadow: 0 0 0 3px rgba(39, 200, 255, 0.14);
}

.pg-login__error {
  min-height: 18px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #ff9f92;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.pg-login__error[data-on="1"] { opacity: 1; }

.pg-login__submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  min-height: 48px;
  padding: 13px 22px;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #06101f;
  cursor: pointer;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(118deg, #8fe3ff 0%, #a99cff 54%, #ffbe6b 100%);
  box-shadow: 0 12px 30px rgba(80, 170, 255, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.5);
  transition: transform 0.16s ease, filter 0.16s ease, opacity 0.16s ease;
  -webkit-tap-highlight-color: transparent;
}

.pg-login__submit:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.05); }
.pg-login__submit:active:not(:disabled) { transform: translateY(0) scale(0.99); }
.pg-login__submit:disabled { cursor: progress; opacity: 0.72; }
.pg-login__submit:focus-visible { outline: 2px solid #9fe8ff; outline-offset: 3px; }

.pg-login__accounts {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid rgba(120, 168, 220, 0.16);
}

.pg-login__accounts-title {
  margin: 0 0 8px;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: #7f97b8;
}

.pg-login__account-list { display: flex; flex-wrap: wrap; gap: 8px; }

.pg-login__account {
  flex: 1 1 150px;
  padding: 9px 11px;
  font: inherit;
  font-size: 11px;
  line-height: 1.45;
  text-align: left;
  color: #c8dcf5;
  cursor: pointer;
  background: rgba(22, 38, 62, 0.6);
  border: 1px solid rgba(116, 176, 235, 0.2);
  border-radius: 10px;
  transition: border-color 0.16s ease, background 0.16s ease;
  -webkit-tap-highlight-color: transparent;
}

.pg-login__account:hover {
  border-color: rgba(98, 208, 255, 0.55);
  background: rgba(34, 58, 92, 0.66);
}

.pg-login__account strong { color: #8fe3ff; font-weight: 700; }
.pg-login__account span { display: block; color: #8fa9ca; }

.pg-login__skip {
  width: 100%;
  margin-top: 10px;
  padding: 10px 16px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: #a9c7e8;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(116, 176, 235, 0.24);
  border-radius: 999px;
  transition: border-color 0.16s ease, color 0.16s ease;
  -webkit-tap-highlight-color: transparent;
}
.pg-login__skip:hover,
.pg-login__skip:focus-visible {
  color: #dff4ff;
  border-color: rgba(98, 208, 255, 0.55);
  outline: none;
}

.pg-login__hint {
  margin: 16px 0 0;
  font-size: 11px;
  line-height: 1.65;
  color: #6f86a6;
}

@keyframes pg-login-rise {
  from { opacity: 0; transform: translateY(20px) scale(0.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 520px) {
  .pg-login__card { padding: 28px 20px 22px; border-radius: 20px; }
  .pg-login__subtitle { font-size: 12px; margin-bottom: 16px; }
}

@media (max-height: 620px) {
  .pg-login__card {
    max-height: calc(100dvh - 20px);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 24px 22px 18px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pg-login, .pg-login__card { transition-duration: 0.01ms; animation: none; }
}
`;

export class LoginScreen {
  constructor(options = {}) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._root = null;
    this._form = null;
    this._fields = {};
    this._accountList = null;
    this._visible = false;
    this._busy = false;
    this._autoTried = false;

    this._onSubmit = (event) => {
      event.preventDefault();
      this._submit();
    };
    this._onAccountClick = (event) => {
      const button = event.target.closest?.('[data-user]');
      if (!button || !this._root || !this._root.contains(button)) return;
      this._fields.user.value = button.dataset.user || '';

      this._setError('');
      this._fields.pass.focus();
    };
    this._onSkipClick = () => {
      const fn = this._options.onSkip;
      if (typeof fn === 'function') fn();
    };
  }

  init(options = {}) {
    this._mergeOptions(options);
    if (!this._root) {
      this._injectStyles();
      this._createDom();
    }
    this._applyTexts();
    return this;
  }

  show() {
    this.init();
    if (!this._root) return this;
    this._visible = true;
    this._root.classList.add('pg-login--visible');
    this._root.setAttribute('aria-hidden', 'false');

    requestAnimationFrame(() => {
      const auto = this._options.autoSubmit
        && !this._autoTried
        && Boolean(this._fields.user?.value)
        && Boolean(this._fields.pass?.value);
      if (auto) {
        this._autoTried = true;
        this._submit();
        return;
      }
      this._fields.user?.focus({ preventScroll: true });
    });
    return this;
  }

  hide() {
    this._visible = false;
    if (!this._root) return this;
    this._root.classList.remove('pg-login--visible');
    this._root.setAttribute('aria-hidden', 'true');
    this._fields.user?.blur();
    this._fields.pass?.blur();
    return this;
  }

  get visible() { return this._visible; }

  dispose() {
    this._visible = false;
    this._autoTried = false;
    if (this._root) {
      this._form?.removeEventListener('submit', this._onSubmit);
      this._accountList?.removeEventListener('click', this._onAccountClick);
      this._fields.skip?.removeEventListener('click', this._onSkipClick);
      this._root.remove();
      this._root = null;
    }
    this._form = null;
    this._accountList = null;
    this._fields = {};
    if (!document.querySelector('.pg-login')) {
      document.getElementById(STYLE_ID)?.remove();
    }
  }

  /* ------------------------------------------------------------------ */

  _mergeOptions(options) {
    if (!options || typeof options !== 'object') return;
    Object.keys(DEFAULT_OPTIONS).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        this._options[key] = options[key];
      }
    });
  }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }

  _createDom() {
    const root = document.createElement('div');
    root.className = 'pg-login';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="pg-login__grid" aria-hidden="true"></div>
      <div class="pg-login__card">
        <p class="pg-login__eyebrow" data-role="eyebrow"></p>
        <h1 class="pg-login__title" data-role="title"></h1>
        <p class="pg-login__subtitle" data-role="subtitle"></p>
        <form class="pg-login__form" novalidate>
          <label class="pg-login__field">账号
            <input data-role="user" name="user" type="text" autocomplete="username"
              spellcheck="false" placeholder="例如 player1" />
          </label>
          <label class="pg-login__field">密码
            <input data-role="pass" name="pass" type="password" autocomplete="current-password"
              placeholder="输入密码" />
          </label>
          <p class="pg-login__error" data-role="error" data-on="0" aria-live="polite"></p>
          <button class="pg-login__submit" type="submit" data-role="submit">
            <span data-role="submit-text">登录并连接</span>
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <div class="pg-login__accounts" data-role="accounts">
          <p class="pg-login__accounts-title">演示账号 · 点一下填入账号</p>
          <div class="pg-login__account-list" data-role="account-list"></div>
        </div>
        <button class="pg-login__skip" type="button" data-role="skip">单人游玩（不联机）</button>
        <p class="pg-login__hint" data-role="hint"></p>
      </div>
    `;

    this._root = root;
    this._form = root.querySelector('form');
    this._accountList = root.querySelector('[data-role="account-list"]');
    this._fields = {
      eyebrow: root.querySelector('[data-role="eyebrow"]'),
      title: root.querySelector('[data-role="title"]'),
      subtitle: root.querySelector('[data-role="subtitle"]'),
      hint: root.querySelector('[data-role="hint"]'),
      user: root.querySelector('[data-role="user"]'),
      pass: root.querySelector('[data-role="pass"]'),
      error: root.querySelector('[data-role="error"]'),
      submit: root.querySelector('[data-role="submit"]'),
      submitText: root.querySelector('[data-role="submit-text"]'),
      accounts: root.querySelector('[data-role="accounts"]'),
      skip: root.querySelector('[data-role="skip"]'),
    };

    this._form.addEventListener('submit', this._onSubmit);
    this._accountList.addEventListener('click', this._onAccountClick);
    this._fields.skip?.addEventListener('click', this._onSkipClick);
    document.body.appendChild(root);
  }

  _applyTexts() {
    if (!this._root) return;
    const options = this._options;
    this._fields.eyebrow.textContent = options.eyebrow;
    this._fields.title.textContent = options.title;
    this._fields.subtitle.textContent = options.subtitle;
    this._fields.hint.textContent = options.hint;
    this._root.setAttribute('aria-label', options.title);

    this._fields.user.value = options.defaultUser || '';
    this._fields.pass.value = options.defaultPass || '';

    const accounts = Array.isArray(options.accounts) ? options.accounts : [];
    this._accountList.innerHTML = '';
    accounts.forEach((account) => {
      if (!account?.user) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pg-login__account';
      button.dataset.user = account.user;
      const strong = document.createElement('strong');
      strong.textContent = `${account.name || account.user} · ${account.user}`;
      const span = document.createElement('span');
      span.textContent = account.hint || '点一下填入账号';
      button.append(strong, span);
      this._accountList.appendChild(button);
    });
    if (this._fields.accounts) {
      this._fields.accounts.style.display = accounts.length ? '' : 'none';
    }
    if (this._fields.skip) {
      this._fields.skip.style.display = typeof options.onSkip === 'function' ? '' : 'none';
    }
  }

  _setError(message) {
    if (!this._fields.error) return;
    this._fields.error.textContent = message || '';
    this._fields.error.dataset.on = message ? '1' : '0';
  }

  _setBusy(busy) {
    if (!this._fields.submit) return;
    this._fields.submit.disabled = busy;
    this._fields.submitText.textContent = busy ? '连接中…' : '登录并连接';
    if (this._fields.user) this._fields.user.disabled = busy;
    if (this._fields.pass) this._fields.pass.disabled = busy;
  }

  async _submit() {
    if (this._busy || !this._visible) return;
    const user = (this._fields.user?.value || '').trim();
    const pass = this._fields.pass?.value || '';
    if (!user || !pass) {
      this._setError('请输入账号和密码');
      return;
    }
    const onLogin = this._options.onLogin;
    if (typeof onLogin !== 'function') {
      this._setError('登录回调未配置');
      return;
    }

    this._busy = true;
    this._setError('');
    this._setBusy(true);
    try {
      await onLogin({ user, pass });
      this.hide();
    } catch (err) {
      this._setError(err?.message || '连接失败，请检查服务是否启动');
    } finally {
      this._busy = false;
      this._setBusy(false);
    }
  }
}

export default LoginScreen;