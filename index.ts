import dotenv from 'dotenv';
dotenv.config();

import express, { type Application } from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
// @ts-ignore
import { setupWSConnection, docs } from 'y-websocket/bin/utils';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
const { Pool } = pg;
import type * as Y from 'yjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Yjs = require('yjs');
import sessionRouter from './routes/session.js';
import { SessionManager } from './services/SessionManager.js';

const app: Application = express();
const PORT = process.env.PORT || 3004;

const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

app.use(cors());
app.use(express.json());

app.use('/', sessionRouter);

const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });

// Initialize custom SessionManager for debounced saving and timeouts
SessionManager.init(prisma, Yjs);

// We no longer use y-websocket's default setPersistence.
// SessionManager natively attached debounced writes at the exact update stream level!
/*
setPersistence({ ... }) 
*/

wss.on('connection', async (conn: any, req: any, { docName }: any) => {
  console.log(`[WS] Connection established for docName: ${docName}`);
  
  // Custom bindState logic explicitly loaded on connection
  try {
    const session = await prisma.session.findUnique({
      where: { id: docName }
    });
    const ydoc = docs.get(docName) || new Yjs.Doc();
    if (session && session.docState) {
      Yjs.applyUpdate(ydoc, session.docState);
    }
  } catch (err) {
    console.error(`[DB] Failed to explicitly bind state for ${docName}:`, err);
  }

  setupWSConnection(conn, req, { docName, gc: true });
  
  const ydoc = docs.get(docName);
  if (ydoc) {
    SessionManager.handleConnection(conn, docName, ydoc);
  }
});

server.on('upgrade', (request, socket, head) => {
  console.log(`[COLLAB-WS] Upgrade request received! URL: ${request.url}`);
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  console.log(`[COLLAB-WS] Parsed pathname: ${url.pathname}`);
  // expected ws url: /api/collaboration/ws/:sessionId
  if (url.pathname.startsWith('/api/collaboration/ws/')) {
    const docName = url.pathname.split('/').pop() || 'default';
    console.log(`[COLLAB-WS] Handling upgrade for docName: ${docName}`);
    wss.handleUpgrade(request, socket, head, (ws: any) => {
      wss.emit('connection', ws, request, { docName });
    });
  } else {
    console.log(`[COLLAB-WS] Rejected upgrade, path mismatch`);
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Collaboration service listening on port ${PORT}`);
});
