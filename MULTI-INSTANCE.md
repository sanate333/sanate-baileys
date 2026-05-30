# Multi-Instance Deployment

## Arquitectura
- 1 instancia (Render service o Fly.io machine) = 1 store = 1 WhatsApp
- Cada instancia es 100% aislada: auth, proxy session, warm-up state
- DB compartida en Supabase con `store_id` segmentation

## Render (1-10 stores, low cost)
1. Mismo repo, deploy NUEVO web service por cada store
2. Env vars por servicio:
   - `STORE_ID=<uuid>` (auto-syncs DEVICE_ID)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `META_TOKEN`, `META_PHONE_NUMBER_ID`
   - `WA_PROXY_URL=socks5://user:pass@gate.proxy-cheap.com:7000`
3. Cada servicio se autenticara con su propio QR la primera vez

## Fly.io (100-1000+ stores, low marginal cost)
1. `fly auth login`
2. Por cada store:
   ```bash
   fly apps create sanate-worker-<slug>
   fly secrets set STORE_ID=<uuid> SUPABASE_URL=... \
     SUPABASE_SERVICE_KEY=... META_TOKEN=... META_PHONE_NUMBER_ID=... \
     WA_PROXY_URL="socks5://user:pass@gate.proxy-cheap.com:7000" \
     -a sanate-worker-<slug>
   cp fly.toml.example fly.toml
   # edit "app" name
   fly deploy -a sanate-worker-<slug>
   ```
3. Costo aproximado: $3/mes por worker activo, auto-stop cuando inactivo

## Master orchestrator (panel)
- El panel frontend usa el edge function `sanate-tiendas` para gestionar metadata
- Para enviar mensajes a un store específico: HTTP POST al worker URL correspondiente
- Worker URL pattern: `https://sanate-worker-<slug>.fly.dev` o `https://sanate-wa-bot-<slug>.onrender.com`

## Aislamiento por store
- **Auth**: `oasis_wa_auth` table con `device_id=<store_id>`
- **Proxy**: cada worker usa `WA_PROXY_URL` con `-session-<shortId>` (sticky por store)
- **Warm-up**: cada worker mantiene su propio warm-up state via baileys-antiban
- **Datos**: chats, mensajes, transferencias, pedidos todos tienen `store_id` column
