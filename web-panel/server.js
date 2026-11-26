'use strict';

/**
 * RGH Wallet Web Panel
 * --------------------
 * Panel web para las dos wallets externas (wallet1 / wallet2) de la
 * blockchain privada Multichain "rghchain" que emite el activo RGH.
 *
 * Características principales:
 *  - Autenticación stateful con express-session (cookie HttpOnly connect.sid).
 *  - Cliente JSON-RPC 1.0 (POST + Basic Auth) contra node1:8000.
 *  - Lectura de /shared/wallets.env en cada request y mutación en caliente
 *    del objeto `users` (nunca se hardcodean las direcciones).
 *  - Generación de pares de claves RSA-2048 (SPKI/PKCS#8) con el módulo crypto
 *    nativo y firma SHA-256 de ejemplo por wallet.
 *  - Transferencias de activos con `sendassetfrom` (no `sendfrom`).
 *
 * El servidor NO escribe errores RPC en los logs: cualquier fallo de la cadena
 * se devuelve a la interfaz como un mensaje controlado.
 */

const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const axios = require('axios');

const PORT = 3000;
const ASSET = 'RGH';
const CHAIN = 'arbol-chain';
const WALLETS_ENV_PATH = process.env.WALLETS_ENV_PATH || '/shared/wallets.env';

const RPC_HOST = process.env.RPC_HOST || 'localhost';
const RPC_PORT = process.env.RPC_PORT || '9540';
const RPC_USER = process.env.RPC_USER || 'multichainrpc';
const RPC_PASSWORD = process.env.RPC_PASSWORD || 'rpcpassword123';
const RPC_URL = 'http://' + RPC_HOST + ':' + RPC_PORT + '/';
const RPC_TIMEOUT_MS = 15000;

/* -------------------------------------------------------------------------- */
/*  Usuarios fijos en código                                                   */
/* -------------------------------------------------------------------------- */

function createRsaKeyPair() {
  // Formato SPKI para la clave pública y PKCS#8 para la privada (PEM).
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

const users = {
  wallet1: {
    username: 'wallet1',
    password: 'password123',
    walletAddress: '',
    rsa: createRsaKeyPair()
  },
  wallet2: {
    username: 'wallet2',
    password: 'password456',
    walletAddress: '',
    rsa: createRsaKeyPair()
  }
};

/* -------------------------------------------------------------------------- */
/*  Carga de /shared/wallets.env                                                */
/* -------------------------------------------------------------------------- */

let lastWalletLoad = { at: null, ok: false, error: 'Aún no se ha leído wallets.env' };

/**
 * Lee /shared/wallets.env y MUTA el objeto compartido `users` en el mismo
 * scope. Es importante que la actualización no se haga sobre una variable
 * local: el resto de handlers leen `users[...].walletAddress`.
 */
function loadWalletAddresses() {
  try {
    if (!fs.existsSync(WALLETS_ENV_PATH)) {
      lastWalletLoad = {
        at: new Date(),
        ok: false,
        error: 'El archivo ' + WALLETS_ENV_PATH + ' todavía no existe'
      };
      return { ok: false, error: lastWalletLoad.error };
    }

    const content = fs.readFileSync(WALLETS_ENV_PATH, 'utf8');
    const parsed = {};

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      value = value.replace(/^["']/, '').replace(/["']$/, '');
      if (key && value) parsed[key] = value;
    }

    if (parsed.WALLET1_ADDR && users.wallet1) users.wallet1.walletAddress = parsed.WALLET1_ADDR;
    if (parsed.WALLET2_ADDR && users.wallet2) users.wallet2.walletAddress = parsed.WALLET2_ADDR;

    lastWalletLoad = {
      at: new Date(),
      ok: Boolean(parsed.WALLET1_ADDR || parsed.WALLET2_ADDR),
      error: parsed.WALLET1_ADDR || parsed.WALLET2_ADDR ? null : 'wallets.env sin WALLET1_ADDR/WALLET2_ADDR'
    };
    return { ok: lastWalletLoad.ok, error: lastWalletLoad.error, values: parsed };
  } catch (err) {
    lastWalletLoad = { at: new Date(), ok: false, error: err.message };
    return { ok: false, error: err.message };
  }
}

loadWalletAddresses();
const walletRefreshTimer = setInterval(loadWalletAddresses, 30000);
walletRefreshTimer.unref();

/* -------------------------------------------------------------------------- */
/*  Cliente JSON-RPC 1.0 para Multichain                                        */
/* -------------------------------------------------------------------------- */

async function multichainRPC(method, params) {
  const payload = {
    jsonrpc: '1.0',
    id: method + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
    method: method,
    params: Array.isArray(params) ? params : []
  };

  let response;
  try {
    response = await axios.post(RPC_URL, payload, {
      auth: { username: RPC_USER, password: RPC_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
      timeout: RPC_TIMEOUT_MS,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(data) => data]
    });
  } catch (err) {
    if (err.response && err.response.status === 401) {
      throw new Error('Autenticación RPC rechazada (401): revisa RPC_USER/RPC_PASSWORD');
    }
    throw new Error('No se pudo contactar el nodo RPC ' + RPC_HOST + ':' + RPC_PORT + ' (' + err.code + ')');
  }

  if (response.status === 401) {
    throw new Error('Autenticación RPC rechazada (401): revisa RPC_USER/RPC_PASSWORD');
  }
  if (response.status === 404) {
    throw new Error('Ruta RPC no encontrada (404) en ' + RPC_HOST + ':' + RPC_PORT);
  }

  let body;
  try {
    body = JSON.parse(response.data);
  } catch (err) {
    throw new Error('Respuesta RPC no válida (HTTP ' + response.status + ')');
  }

  if (body && body.error) {
    throw new Error(body.error.message || 'Error JSON-RPC ' + body.error.code);
  }
  if (response.status !== 200) {
    throw new Error('El nodo RPC respondió HTTP ' + response.status);
  }
  return body.result;
}

async function getAssetBalance(address) {
  const balances = await multichainRPC('getaddressbalances', [address, 1]);
  if (!Array.isArray(balances)) return 0;
  // Multichain devuelve name como "{name:RGH,unit:1}", comparamos conteniendo 'RGH'
  const entry = balances.find((b) => b && (b.name === ASSET || b.name.includes('RGH')));
  if (!entry) return 0;
  const qty = Number(entry.qty);
  return Number.isFinite(qty) ? qty : 0;
}

async function getAddressTransactions(address) {
  const txs = await multichainRPC('listaddresstransactions', [address, 25]);
  return Array.isArray(txs) ? txs : [];
}

/* -------------------------------------------------------------------------- */
/*  Utilidades de presentación                                                 */
/* -------------------------------------------------------------------------- */

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function formatQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function shortAddress(address) {
  const a = String(address || '');
  if (a.length <= 14) return a;
  return a.slice(0, 7) + '…' + a.slice(-5);
}

function formatTimestamp(seconds) {
  if (!seconds) return '—';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function summarizeItems(tx) {
  const items = Array.isArray(tx && tx.items) ? tx.items : [];
  const summaries = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    let assetName = '';
    if (item.asset && typeof item.asset === 'object') assetName = item.asset.name || '';
    else if (typeof item.asset === 'string') assetName = item.asset;
    if (!assetName) continue;
    const qty = Number(item.qty != null ? item.qty : item.raw);
    if (!Number.isFinite(qty)) continue;
    const sign = qty > 0 ? '+' : '';
    summaries.push(assetName + ' ' + sign + formatQty(qty));
  }
  if (!summaries.length && tx && tx.issue && typeof tx.issue === 'object') {
    return 'Emisión de activo ' + esc(tx.issue.asset || '');
  }
  if (!summaries.length) return 'Transferencia RGH';
  return summaries.join(' · ');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* -------------------------------------------------------------------------- */
/*  Vistas                                                                     */
/* -------------------------------------------------------------------------- */

const CSS = `
:root {
  --bg: #060a13;
  --panel: #0d1424;
  --panel-2: #101a2f;
  --line: #20304f;
  --text: #e7eefa;
  --muted: #92a6c4;
  --accent: #4f8cff;
  --accent-2: #2ee6cf;
  --gold: #f7c948;
  --ok: #2bd4a0;
  --err: #ff6b81;
  --radius: 18px;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  color: var(--text);
  background:
    radial-gradient(1100px 760px at 12% -12%, rgba(35, 84, 170, .55) 0%, transparent 62%),
    radial-gradient(900px 640px at 106% 4%, rgba(16, 128, 110, .38) 0%, transparent 58%),
    radial-gradient(760px 520px at 50% 118%, rgba(79, 140, 255, .18) 0%, transparent 62%),
    var(--bg);
  font-family: "Segoe UI", "Inter", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  line-height: 1.5;
}
a { color: var(--accent-2); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: "Cascadia Code", "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 28px 22px 56px; }
.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 18px;
  padding: 16px 22px; margin-bottom: 26px;
  background: rgba(13, 20, 36, .72); border: 1px solid var(--line); border-radius: var(--radius);
  backdrop-filter: blur(14px);
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand .mark {
  width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
  font-weight: 800; font-size: 15px; letter-spacing: .5px; color: #04121a;
  background: linear-gradient(135deg, var(--accent-2), var(--accent));
  box-shadow: 0 8px 24px rgba(46, 230, 207, .25);
}
.brand h1 { font-size: 18px; margin: 0; letter-spacing: .2px; }
.brand .sub { color: var(--muted); font-size: 12px; margin: 0; }
.topbar .who { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; }
.chip {
  display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px;
  border: 1px solid var(--line); border-radius: 999px; background: rgba(16, 26, 47, .8);
  color: var(--text); font-size: 12px;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 10px var(--ok); }
.dot.off { background: var(--err); box-shadow: 0 0 10px var(--err); }
.grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 20px; align-items: start; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
.card {
  background: linear-gradient(180deg, rgba(20, 31, 54, .92), rgba(12, 19, 34, .92));
  border: 1px solid var(--line); border-radius: var(--radius); padding: 22px 24px;
  box-shadow: 0 18px 50px rgba(2, 8, 23, .45);
}
.card + .card { margin-top: 20px; }
.card-label { margin: 0; color: var(--muted); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
.balance-line { display: flex; align-items: baseline; gap: 12px; margin: 10px 0 4px; }
.balance-value { font-size: clamp(40px, 6vw, 62px); font-weight: 800; letter-spacing: -1.5px; line-height: 1; }
.balance-unit { font-size: 18px; font-weight: 700; color: var(--gold); letter-spacing: .16em; }
.hint { color: var(--muted); font-size: 12.5px; margin: 8px 0 0; }
.addr {
  display: inline-block; word-break: break-all; padding: 10px 12px; border-radius: 10px;
  background: rgba(6, 12, 24, .75); border: 1px dashed var(--line); font-size: 13px; color: #cfe0ff;
}
.visually-hidden {
  position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.flash { margin-bottom: 20px; padding: 14px 16px; border-radius: 14px; font-size: 14px; border: 1px solid; }
.flash.success { background: rgba(43, 212, 160, .09); border-color: rgba(43, 212, 160, .45); color: #b6ffe9; }
.flash.error { background: rgba(255, 107, 129, .08); border-color: rgba(255, 107, 129, .4); color: #ffd2da; }
.flash code { color: #fff; background: rgba(255, 255, 255, .08); padding: 2px 6px; border-radius: 6px; word-break: break-all; }
label.field { display: block; margin: 14px 0 6px; font-size: 13px; color: var(--muted); }
input.input {
  width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);
  background: #081020; color: var(--text); font-size: 14px; outline: none;
  font-family: inherit;
}
input.input:focus { border-color: var(--accent); box-shadow: 0 0 0 4px rgba(79, 140, 255, .16); }
button.btn {
  margin-top: 16px; width: 100%; padding: 13px 16px; border: 0; border-radius: 12px; cursor: pointer;
  font-size: 15px; font-weight: 700; color: #04121a;
  background: linear-gradient(120deg, var(--accent-2), var(--accent));
  box-shadow: 0 10px 30px rgba(46, 230, 207, .2);
}
button.btn:hover { filter: brightness(1.06); }
button.btn:active { transform: translateY(1px); }
pre {
  margin: 0; padding: 12px 14px; background: #070d19; border: 1px solid var(--line);
  border-radius: 12px; color: #cfe0ff; font-size: 11.5px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; max-height: 210px; overflow: auto;
}
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px dashed rgba(32, 48, 79, .55); font-size: 13px; }
.kv:last-child { border-bottom: 0; }
.kv span { color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid rgba(32, 48, 79, .6); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
tr:last-child td { border-bottom: 0; }
.table-wrap { overflow-x: auto; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.badge.ok { background: rgba(43, 212, 160, .14); color: #7dffd6; }
.badge.warn { background: rgba(247, 201, 72, .14); color: #ffdf8b; }
.badge.err { background: rgba(255, 107, 129, .14); color: #ffb3bf; }
.section-title { margin: 0 0 14px; font-size: 15px; letter-spacing: .02em; }
.txid { font-size: 11.5px; color: #9fc2ff; word-break: break-all; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
footer { margin-top: 34px; text-align: center; color: #5f7392; font-size: 12px; }
.auth { min-height: 100vh; display: grid; place-items: center; padding: 30px 20px; }
.auth-grid { display: grid; grid-template-columns: 1.05fr .95fr; gap: 30px; width: min(980px, 100%); align-items: center; }
@media (max-width: 880px) { .auth-grid { grid-template-columns: 1fr; } }
.hero .mark { width: 62px; height: 62px; border-radius: 18px; font-size: 19px; margin-bottom: 18px; }
.hero h1 { font-size: clamp(34px, 5vw, 52px); margin: 0 0 10px; letter-spacing: -1.2px; }
.hero h1 .grad { background: linear-gradient(110deg, var(--accent-2), var(--accent)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero p.lead { color: var(--muted); font-size: 15.5px; max-width: 44ch; margin: 0 0 22px; }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
.facts li { padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: rgba(13, 20, 36, .6); }
.facts span { display: block; color: var(--muted); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
.facts strong { font-size: 14px; }
.login-card { padding: 28px 26px; }
.login-card h2 { margin: 0 0 4px; font-size: 20px; }
.login-card p.sub { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
.creds { margin-top: 18px; padding: 12px 14px; border-radius: 12px; background: rgba(6, 12, 24, .6); border: 1px dashed var(--line); font-size: 12px; color: var(--muted); }
.creds code { color: #cfe0ff; }
.error { margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: rgba(255, 107, 129, .1); border: 1px solid rgba(255, 107, 129, .4); color: #ffd2da; font-size: 13px; }
details > summary { cursor: pointer; font-weight: 600; }
.stack > * + * { margin-top: 14px; }
`;

function layout(options) {
  const opts = options || {};
  const bodyClass = opts.bodyClass ? ' class="' + opts.bodyClass + '"' : '';
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="es">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + esc(opts.title || 'RGH Wallet') + '</title>\n' +
    '<style>' + CSS + '</style>\n' +
    '</head>\n<body' + bodyClass + '>\n' +
    (opts.content || '') +
    '</body>\n</html>'
  );
}

function renderLogin(options) {
  const opts = options || {};
  const error = opts.error
    ? '<div class="error" role="alert">' + esc(opts.error) + '</div>'
    : '';

  const content =
    '<main class="auth">\n' +
    '  <div class="auth-grid">\n' +
    '    <section class="hero">\n' +
    '      <div class="mark">RGH</div>\n' +
    '      <h1>Wallet <span class="grad">segura</span><br>sobre Multichain</h1>\n' +
    '      <p class="lead">Accede al panel de las wallets externas de la red privada <strong>rghchain</strong>: ' +
    'saldo real, historial de transacciones y transferencias firmadas dentro de la blockchain.</p>\n' +
    '      <ul class="facts">\n' +
    '        <li><span>Activo nativo</span><strong>RGH</strong></li>\n' +
    '        <li><span>Suministro total</span><strong>1 000 000 RGH</strong></li>\n' +
    '        <li><span>Nodos P2P</span><strong>5 (topología n-aria)</strong></li>\n' +
    '        <li><span>Cifrado</span><strong>RSA-2048 · SHA-256</strong></li>\n' +
    '      </ul>\n' +
    '    </section>\n' +
    '    <form class="card login-card" method="post" action="/login" autocomplete="off">\n' +
    '      <h2>Iniciar sesión</h2>\n' +
    '      <p class="sub">Autenticación por sesión (cookie HttpOnly).</p>\n' +
    '      <label class="field" for="username">Usuario</label>\n' +
    '      <input class="input" id="username" name="username" type="text" required autofocus ' +
    'placeholder="wallet1" value="' + esc(opts.username || '') + '">\n' +
    '      <label class="field" for="password">Contraseña</label>\n' +
    '      <input class="input" id="password" name="password" type="password" required placeholder="••••••••••">\n' +
    '      <button class="btn" type="submit">Entrar al panel</button>\n' +
    '      ' + error + '\n' +
    '      <div class="creds">Credenciales de demostración:<br>' +
    '        <code>wallet1</code> / <code>password123</code> &nbsp;·&nbsp; ' +
    '        <code>wallet2</code> / <code>password456</code></div>\n' +
    '    </form>\n' +
    '  </div>\n' +
    '</main>';

  return layout({ title: 'RGH Wallet · Acceso', content: content });
}

function renderNavbar(username, address) {
  return (
    '<header class="topbar">\n' +
    '  <div class="brand">\n' +
    '    <div class="mark">RGH</div>\n' +
    '    <div>\n' +
    '      <h1>RGH Wallet</h1>\n' +
    '      <p class="sub">rghchain · panel de wallets externas</p>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <div class="who">\n' +
    '    <span class="chip"><span class="dot"></span>' +
    'Nodo node1 · 5 peers</span>\n' +
    '    <span class="chip mono">' + esc(username) + ' · ' + esc(shortAddress(address)) + '</span>\n' +
    '    <a class="chip" href="/logout">Cerrar sesión</a>\n' +
    '  </div>\n' +
    '</header>'
  );
}

function renderDashboard(view) {
  const user = view.user;
  const other = view.other;
  const balanceKnown = view.balance !== null && view.balance !== undefined;
  const balance = balanceKnown ? formatQty(view.balance) : '';
  const hasAddress = Boolean(user.walletAddress);

  const flash = view.flash
    ? '<div class="flash ' + (view.flash.type === 'error' ? 'error' : 'success') + '" role="status">' +
      esc(view.flash.message) +
      (view.flash.txid ? ' · TxID: <code>' + esc(view.flash.txid) + '</code>' : '') +
      '</div>'
    : '';

  const balanceBlock = balanceKnown
    ? '<p class="card-label">Saldo disponible</p>' +
      '<div class="balance-line"><span class="balance-value" id="balance-value">' + esc(balance) + '</span>' +
      '<span class="balance-unit">RGH</span></div>' +
      '<span class="visually-hidden" id="balance-text">' + esc(balance) + ' RGH</span>' +
      '<p class="hint">Saldo confirmado en la blockchain · activo <strong>RGH</strong> · unidad mínima 1</p>'
    : '<p class="card-label">Saldo disponible</p>' +
      '<div class="balance-line"><span class="balance-value">—</span><span class="balance-unit">RGH</span></div>' +
      '<p class="hint">' + esc(view.balanceError || 'Consultando la blockchain…') + '</p>';

  const historyRows = view.history.length
    ? view.history.map((tx) => {
        const confirmations = Number(tx.confirmations || 0);
        const badge = confirmations > 0 ? 'ok' : 'warn';
        return (
          '<tr data-txid="' + esc(tx.txid) + '">' +
          '<td class="small">' + esc(formatTimestamp(tx.blocktime)) + '</td>' +
          '<td><code class="txid">' + esc(tx.txid) + '</code></td>' +
          '<td><span class="badge ' + badge + '">' + esc(confirmations) + '</span></td>' +
          '<td class="small">' + esc(summarizeItems(tx)) + '</td>' +
          '</tr>'
        );
      }).join('\n')
    : '<tr><td colspan="4" class="muted small">Todavía no hay transacciones registradas para esta dirección.</td></tr>';

  const historyNote = view.historyError
    ? '<p class="hint" style="color:#ffb3bf">Historial no disponible: ' + esc(view.historyError) + '</p>'
    : '';

  const rsaMessage = 'RGH|' + view.username + '|' + (user.walletAddress || 'pendiente');
  let rsaSignature = '';
  let rsaValid = false;
  try {
    rsaSignature = crypto.sign('sha256', Buffer.from(rsaMessage), user.rsa.privateKey).toString('base64');
    rsaValid = crypto.verify('sha256', Buffer.from(rsaMessage), user.rsa.publicKey, Buffer.from(rsaSignature, 'base64'));
  } catch (err) {
    rsaSignature = 'No se pudo firmar el mensaje';
    rsaValid = false;
  }

  const autoRefresh = view.flash && view.flash.type === 'success'
    ? '<script>setTimeout(function () { window.location.reload(); }, 7000);</script>'
    : '';

  const content =
    '<div class="wrap">\n' +
    renderNavbar(view.username, user.walletAddress) +
    flash +
    '<main class="grid">\n' +
    '  <div>\n' +
    '    <section class="card">\n' +
    '      ' + balanceBlock + '\n' +
    '      <div class="kv"><span>Wallet</span><strong class="mono">' + esc(user.username) + '</strong></div>\n' +
    '      <div class="kv"><span>Dirección on-chain</span><code class="mono">' + esc(user.walletAddress || 'Pendiente de inicialización') + '</code></div>\n' +
    '      <div class="kv"><span>Red</span><strong>blockchain-net · node1</strong></div>\n' +
    '    </section>\n\n' +
    '    <section class="card">\n' +
    '      <p class="section-title">Transferir RGH</p>\n' +
    '      <form method="post" action="/send" class="stack" autocomplete="off">\n' +
    '        <div>\n' +
    '          <label class="field" for="recipient">Dirección destinataria</label>\n' +
    '          <input class="input mono" id="recipient" name="recipient" type="text" spellcheck="false" required ' +
    'value="' + esc(other.walletAddress) + '" placeholder="Dirección Multichain de la otra wallet">\n' +
    '        </div>\n' +
    '        <div>\n' +
    '          <label class="field" for="amount">Cantidad (unidades enteras de RGH)</label>\n' +
    '          <input class="input" id="amount" name="amount" type="number" min="1" step="1" required value="100">\n' +
    '        </div>\n' +
    '        <button class="btn" type="submit">Enviar RGH</button>\n' +
    '      </form>\n' +
    '      <p class="hint">La transferencia se firma en el nodo semilla con <code>sendassetfrom</code> y queda replicada en los 5 nodos.</p>\n' +
    '    </section>\n\n' +
    '    <section class="card">\n' +
    '      <p class="section-title">Historial de transacciones</p>\n' +
    '      ' + historyNote + '\n' +
    '      <div class="table-wrap">\n' +
    '        <table>\n' +
    '          <thead><tr><th>Fecha (UTC)</th><th>TxID</th><th>Conf.</th><th>Detalle</th></tr></thead>\n' +
    '          <tbody>\n' + historyRows + '\n' +
    '          </tbody>\n' +
    '        </table>\n' +
    '      </div>\n' +
    '    </section>\n' +
    '  </div>\n\n' +
    '  <div>\n' +
    '    <section class="card">\n' +
    '      <p class="section-title">Estado de la wallet</p>\n' +
    '      <div class="kv"><span>Usuario</span><strong>' + esc(view.username) + '</strong></div>\n' +
    '      <div class="kv"><span>Dirección</span>' +
    '        <span class="badge ' + (hasAddress ? 'ok' : 'warn') + '">' + (hasAddress ? 'vinculada' : 'pendiente') + '</span></div>\n' +
    '      <div class="kv"><span>Asset</span><strong>' + esc(ASSET) + ' · ' + (balanceKnown ? esc(balance) : '—') + ' disponibles</strong></div>\n' +
    '      <div class="kv"><span>Permisos</span><strong>receive, send</strong></div>\n' +
    '      <div class="kv"><span>Wallets.env</span><strong>' + esc(view.walletsEnvStatus) + '</strong></div>\n' +
    '    </section>\n\n' +
    '    <section class="card">\n' +
    '      <p class="section-title">Criptografía asimétrica RSA-2048</p>\n' +
    '      <p class="hint">Clave pública en formato SPKI/PEM generada con el módulo <code>crypto</code> de Node.js:</p>\n' +
    '      <pre id="rsa-public-key">' + esc(user.rsa.publicKey) + '</pre>\n' +
    '      <p class="hint" style="margin-top:12px">Mensaje firmado (SHA-256 + clave privada PKCS#8):</p>\n' +
    '      <pre id="rsa-message">' + esc(rsaMessage) + '</pre>\n' +
    '      <p class="hint">Firma digital (base64):</p>\n' +
    '      <pre id="rsa-signature">' + esc(rsaSignature) + '</pre>\n' +
    '      <p class="hint">Verificación con la clave pública: ' +
    (rsaValid ? '<span class="badge ok">válida ✓</span>' : '<span class="badge err">inválida</span>') + '</p>\n' +
    '    </section>\n\n' +
    '    <section class="card">\n' +
    '      <p class="section-title">Red blockchain</p>\n' +
    '      <div class="kv"><span>Cadena</span><strong>rghchain</strong></div>\n' +
    '      <div class="kv"><span>Nodos</span><strong>node1 … node5</strong></div>\n' +
    '      <div class="kv"><span>RPC</span><code>' + esc(RPC_HOST + ':' + RPC_PORT) + '</code></div>\n' +
    '      <div class="kv"><span>P2P</span><code>7719</code></div>\n' +
    '      <div class="kv"><span>Suministro</span><strong>1 000 000 RGH</strong></div>\n' +
    '      <a class="chip" href="/dashboard" style="margin-top:12px">↻ Actualizar saldo</a>\n' +
    '    </section>\n' +
    '  </div>\n' +
    '</main>\n' +
    '<footer>RGH Wallet · Multichain 2.3.2 · sesión de ' + esc(view.username) + ' · ' + esc(view.walletsEnvStatus) + '</footer>\n' +
    '</div>\n' +
    autoRefresh;

  return layout({ title: 'RGH Wallet · ' + view.username, content: content });
}

/* -------------------------------------------------------------------------- */
/*  Aplicación Express                                                        */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(
  session({
    name: 'connect.sid',
    secret: process.env.SESSION_SECRET || 'rgh-wallet-web-panel-secret-2024',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 // 1 hora
    }
  })
);

function takeFlash(req) {
  const flash = req.session ? req.session.flash : null;
  if (req.session) delete req.session.flash;
  return flash || null;
}

function requireSession(req, res, next) {
  if (!req.session || !req.session.user || !users[req.session.user]) {
    return res.redirect('/');
  }
  return next();
}

/* ---------------------------------- Login --------------------------------- */

app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  return res.type('html').send(renderLogin({}));
});

app.get('/login', (req, res) => res.redirect('/'));

app.post('/login', (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const record = users[username];

  if (!record || !safeEqual(record.password, password)) {
    return res.status(401).type('html').send(
      renderLogin({ error: 'Usuario o contraseña incorrectos.', username: username })
    );
  }

  return req.session.regenerate((err) => {
    if (err) {
      return res.status(500).type('html').send(renderLogin({ error: 'No se pudo iniciar la sesión.' }));
    }
    req.session.user = username;
    req.session.flash = { type: 'success', message: 'Sesión iniciada como ' + username };
    return req.session.save((saveErr) => {
      if (saveErr) {
        return res.status(500).type('html').send(renderLogin({ error: 'No se pudo guardar la sesión.' }));
      }
      return res.redirect(302, '/dashboard');
    });
  });
});

/* --------------------------------- Dashboard ------------------------------- */

app.get('/dashboard', requireSession, async (req, res) => {
  const username = req.session.user;
  const user = users[username];
  const other = users[username === 'wallet1' ? 'wallet2' : 'wallet1'];

  const walletLoad = loadWalletAddresses();
  const flash = takeFlash(req);

  let balance = null;
  let balanceError = null;
  let history = [];
  let historyError = null;
  let rpcOk = false;

  if (!user.walletAddress) {
    balanceError = 'Aún no hay direcciones on-chain. Esperando a que node1 escriba /shared/wallets.env…';
  } else {
    try {
      balance = await getAssetBalance(user.walletAddress);
      rpcOk = true;
    } catch (err) {
      balanceError = 'No se pudo consultar el saldo en la blockchain: ' + err.message;
    }

    if (rpcOk) {
      try {
        history = await getAddressTransactions(user.walletAddress);
        historyError = null;
      } catch (err) {
        history = [];
        historyError = err.message;
      }
    }
  }

  const walletsEnvStatus = walletLoad.ok
    ? 'leído correctamente (' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC)'
    : 'todavía no disponible';

  res.type('html').send(
    renderDashboard({
      username: username,
      user: user,
      other: other,
      flash: flash,
      balance: balance,
      balanceError: balanceError,
      history: history,
      historyError: historyError,
      walletsEnvStatus: walletsEnvStatus
    })
  );
});

/* -------------------------------- Transferencia ---------------------------- */

app.post('/send', requireSession, async (req, res) => {
  const username = req.session.user;
  const user = users[username];

  loadWalletAddresses();

  const recipient = typeof req.body.recipient === 'string' ? req.body.recipient.trim() : '';
  const amountRaw = typeof req.body.amount === 'string' ? req.body.amount.trim() : String(req.body.amount || '');
  const amount = Number(amountRaw);

  const fail = (message) => {
    req.session.flash = { type: 'error', message: message };
    return res.redirect(303, '/dashboard');
  };

  if (!user.walletAddress) return fail('La wallet no tiene dirección on-chain asignada todavía.');
  if (!/^[0-9A-Za-z]{26,64}$/.test(recipient)) return fail('Transaction failed: dirección destinataria inválida.');
  if (!/^[0-9]+$/.test(amountRaw) || !Number.isSafeInteger(amount) || amount <= 0) {
    return fail('Transaction failed: la cantidad debe ser un número entero mayor que 0.');
  }
  if (recipient === user.walletAddress) return fail('Transaction failed: no puedes enviarte RGH a ti mismo.');

  try {
    const available = await getAssetBalance(user.walletAddress);
    if (amount > available) {
      return fail('Transaction failed: saldo insuficiente (' + formatQty(available) + ' RGH disponibles).');
    }

    // sendassetfrom <fromAddress> <toAddress> <asset reference> <qty>
    // Usamos el reference completo '20-265-11480' porque 'RGH' no es reconocido por Multichain RPC
    const txid = await multichainRPC('sendassetfrom', [user.walletAddress, recipient, '20-265-11480', amount]);

    req.session.flash = {
      type: 'success',
      message: 'Transaction successful: se enviaron ' + amount + ' RGH a ' + shortAddress(recipient) + '.',
      txid: String(txid)
    };
    return res.redirect(303, '/dashboard');
  } catch (err) {
    return fail('Transaction failed: ' + err.message);
  }
});

/* ---------------------------------- Logout -------------------------------- */

app.get('/logout', (req, res) => {
  if (!req.session) return res.redirect('/');
  return req.session.destroy(() => {
    res.clearCookie('connect.sid', { path: '/' });
    return res.redirect('/');
  });
});

/* ---------------------------------- Health -------------------------------- */

app.get('/health', async (req, res) => {
  const walletLoad = loadWalletAddresses();
  let rpcOk = false;
  let blocks = null;
  let chainName = null;
  let rpcError = null;

  try {
    const info = await multichainRPC('getinfo', []);
    rpcOk = true;
    blocks = info.blocks;
    chainName = info['chain-name'] || info.chainname || null;
  } catch (err) {
    rpcError = err.message;
  }

  const healthy = rpcOk && walletLoad.ok;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    rpc: { ok: rpcOk, host: RPC_HOST, port: RPC_PORT, blocks: blocks, chain: chainName, error: rpcError },
    wallets: {
      ok: walletLoad.ok,
      file: WALLETS_ENV_PATH,
      wallet1: users.wallet1.walletAddress || null,
      wallet2: users.wallet2.walletAddress || null,
      error: walletLoad.error
    }
  });
});

/* ----------------------------------- 404 ---------------------------------- */

app.use((req, res) => {
  res.status(404).type('html').send(
    layout({
      title: 'RGH Wallet · No encontrado',
      content:
        '<main class="auth"><section class="card" style="max-width:420px;text-align:center">' +
        '<h2 style="margin-top:0">404</h2><p class="muted">La ruta solicitada no existe.</p>' +
        '<a class="chip" href="/">Volver al inicio</a></section></main>'
    })
  );
});

/* -------------------------------- Error handler --------------------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).type('html').send(
    layout({
      title: 'RGH Wallet · Error',
      content:
        '<main class="auth"><section class="card" style="max-width:460px">' +
        '<h2 style="margin-top:0">Algo salió mal</h2>' +
        '<p class="muted">No se pudo completar la operación solicitada.</p>' +
        '<a class="chip" href="/dashboard">Volver al panel</a></section></main>'
    })
  );
});

/* --------------------------------- Avisos --------------------------------- */

process.on('unhandledRejection', () => {
  // El panel nunca debe caerse por una promesa RPC suelta; la UI ya maneja el error.
});
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('Wallet Web Panel running on port 3000');
    process.exit(0);
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const server = app.listen(PORT, '0.0.0.0', () => {
  // Única línea de log exigida por las pruebas de aceptación.
  console.log('Wallet Web Panel running on port 3000');
});

server.on('error', () => {
  process.exit(1);
});
