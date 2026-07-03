# ZapSell — WhatsApp AI Business Operating System

## Tech Stack
- **Backend**: Node.js + TypeScript
- **WhatsApp**: Baileys (Phase 1) — behind an adapter interface for easy migration to Meta Cloud API
- **Database**: Supabase (PostgreSQL)
- **Queue**: BullMQ (Redis)
- **Hosting**: Railway

## Getting Started

### 1. Prerequisites
- Node.js 20+
- Docker + Docker Compose (for local Redis)
- A Supabase project

### 2. Database Setup
Run `schema.sql` in your Supabase SQL editor (once):
```bash
# Or paste the contents of schema.sql into the Supabase SQL editor
```

### 3. Environment
```bash
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEFAULT_CLIENT_ID
```

### 4. Install Dependencies
```bash
npm install
```

### 5. Start Redis
```bash
docker-compose up -d
```

### 6. Create a client row in Supabase
Insert one row into the `clients` table and copy the generated UUID into `DEFAULT_CLIENT_ID` in your `.env`.

### 7. Run
```bash
npm run dev
```
Scan the QR code printed to the console with WhatsApp. After pairing, send a text — you'll receive an echo reply.

## Folder Structure
```
/src
  /config       — env validation
  /db           — Supabase client + multi-tenant repository layer
  /lib/ai       — AI abstraction scaffold (empty, Day 1)
  /queue        — BullMQ queue, worker, and types
  /whatsapp     — Baileys adapter (behind IWhatsAppAdapter interface)
  /webhooks     — Incoming event handler
  /router       — Message routing logic
  index.ts      — Entry point + graceful shutdown
schema.sql      — Run once in Supabase
.env.example    — Copy to .env, fill in values
docker-compose.yml — Local Redis for BullMQ
```

## Day 1 Definition of Done
- [x] QR code scan connects a WhatsApp number
- [x] Inbound text message is logged in `messages` table under correct `client_id`
- [x] Echo reply sent back through BullMQ queue
- [x] Server restart reconnects without re-scanning QR
- [x] Every DB query visibly filters by `client_id`

## Architecture Notes
- **Multi-tenant isolation**: Every DB query filters by `client_id`. `BaseRepository.tenantInsert()` and `tenantUpdate()` always inject `client_id` — callers cannot bypass this.
- **WhatsApp abstraction**: All Baileys code is behind `IWhatsAppAdapter`. The router and queue worker never import Baileys directly.
- **Message queue**: All outgoing messages go through BullMQ. No direct sends from handlers.
- **AI scaffold**: `/src/lib/ai/` is reserved for the AI client wrapper. No direct AI provider calls will ever appear in business logic.
- **Session persistence**: Auth state is stored in `clients.wa_session_data` in Supabase with debounced writes + immediate flush on SIGTERM/SIGINT.
