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

SessionManager.init(prisma, Yjs);

wss.on('connection', async (conn: any, req: any, { docName }: any) => {
  console.log(`[WS] Connection established for docName: ${docName}`);

  // 1. establish the connection which internally creates and registers the Y.Doc
  setupWSConnection(conn, req, { docName, gc: true });

  const ydoc = docs.get(docName);

  // 2. fetch Prisma state and save the ydoc instance.
  try {
    const session = await prisma.session.findUnique({
      where: { id: docName }
    });

    if (session && session.status === 'terminated') {
      console.log(`[WS] Rejecting connection because session is terminated: ${docName}`);
      conn.close(4000, 'Session has been permanently terminated.');
      return;
    }

    if (session && session.docState && ydoc) {
      Yjs.applyUpdate(ydoc, session.docState);
    }
  } catch (err) {
    console.error(`[DB] Failed to explicitly bind state for ${docName}:`, err);
  }

  if (ydoc) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId') || req.headers['x-user-id']?.toString() || 'anonymous';
    SessionManager.handleConnection(conn, docName, ydoc, userId);
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
