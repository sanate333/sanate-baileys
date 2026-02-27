const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const pino = require('pino');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const SECRET = process.env.SECRET || process.env.BAILEYS_SECRET || 'sanate_secret_2025';
const PORT = process.env.PORT || 3000;
const AUTH_DIR = './auth_info';

let sock = null, currentQR = null, status = 'disconnected', reconnectTimer = null;

async function connectToWhatsApp() {
    try {
          if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
          const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
          const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
              version,
              auth: state,
              printQRInTerminal: true,
              loggconst { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
        const express = require('express');
      const cors = require('cors');
      const qrcode = require('qrcode');
      const fs = require('fs');
      const pino = require('pino');

  const app = express();
      app.use(cors({ origin: '*' }));
      app.use(express.json());

  const SECRET = process.env.SECRET || process.env.BAILEYS_SECRET || 'sanate_secret_2025';
      const PORT = process.env.PORT || 3000;
      const AUTH_DIR = './auth_info';

  let sock = null, currentQR = null, status = 'disconnected', reconnectTimer = null;

  async function connectToWhatsApp() {
      try {
            if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
            const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: true,
                logger: pino({ level: 'silent' }),
                browser: ['Sanate Bot', 'Chrome', '1.0'],
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                retryRequestDelayMs: 2000,
        });

        sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                console.log('connection.update:', { connection, hasQR: !!qr });
                if (qr) {
                          currentQR = qr;
                          status = 'qr';
                          console.log('QR generado, listo para escanear');
                }
                if (connection === 'close') {
                          status = 'disconnected';
                          currentQR = null;
                          const code = lastDisconnect?.error?.output?.statusCode;
                          console.log('Conexion cerrada, codigo:', code);
                          if (code !== DisconnectReason.loggedOut) {
                                      console.log('Reconectando en 5s...');
                                      if (reconnectTimer) clear
