import type { WebSocket } from 'ws';
import type { PrismaClient } from '@prisma/client';

function debounce(func: Function, wait: number) {
  let timeout: NodeJS.Timeout | null = null;
  return (...args: any[]) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const GRACE_PERIOD = 2 * 60 * 1000; // 2 minutes
const DEBOUNCE_WAIT = 2000; // 2 seconds

interface ActiveSessionData {
  connections: Set<WebSocket>;
  userMap: Map<WebSocket, string>;
  gracePeriodTimeout?: NodeJS.Timeout | undefined;
  inactivityTimeout?: NodeJS.Timeout | undefined;
  cleanup?: (() => void) | undefined;
  ydoc: any;
  // set while deliberate/system termination is in progress (before sockets are closed)
  terminating?: boolean;
}

const activeSessions = new Map<string, ActiveSessionData>();

export class SessionManager {
  static prisma: PrismaClient;
  static Yjs: any;

  static init(prismaClient: PrismaClient, yjsLib: any) {
    this.prisma = prismaClient;
    this.Yjs = yjsLib;
  }

  static handleConnection(ws: WebSocket, docName: string, ydoc: any, userId: string) {
    if (!this.prisma) throw new Error("SessionManager not initialized with prisma!");

    if (!activeSessions.has(docName)) {
      activeSessions.set(docName, { connections: new Set(), userMap: new Map(), ydoc });

      const sessionData = activeSessions.get(docName)!;

      const debouncedSave = debounce(async () => {
        const state = SessionManager.Yjs.encodeStateAsUpdate(ydoc);
        try {
          await SessionManager.prisma.session.update({
            where: { id: docName },
            data: { docState: Buffer.from(state) }
          });
        } catch (e) {
          console.error(`[SessionManager] Failed to persist ydoc state for ${docName}:`, e);
        }
      }, DEBOUNCE_WAIT);

      const handleUpdate = () => {
        debouncedSave();
        this.resetInactivityTimer(docName);
      };

      ydoc.on('update', handleUpdate);
      this.resetInactivityTimer(docName);

      sessionData.cleanup = () => {
        ydoc.off('update', handleUpdate);
      };
    }

    const sessionData = activeSessions.get(docName)!;
    sessionData.connections.add(ws);
    sessionData.userMap.set(ws, userId);

    // if a user connects, clear any ongoing disconnection grace period only if room is full
    if (sessionData.gracePeriodTimeout && sessionData.connections.size >= 2) {
      clearTimeout(sessionData.gracePeriodTimeout);
      sessionData.gracePeriodTimeout = undefined;
      console.log(`[SessionManager] ${docName}: Grace period cleared, user rejoined.`);
    }

    ws.on('close', () => {
      const droppedUser = sessionData.userMap.get(ws) || 'unknown';
      sessionData.connections.delete(ws);
      sessionData.userMap.delete(ws);
      console.log(`[SessionManager] ${docName}: Client disconnected. Remaining: ${sessionData.connections.size}`);

      // do not start accidental-disconnect grace while a deliberate terminate is closing sockets
      if (sessionData.terminating) {
        return;
      }

      if (sessionData.connections.size < 2) {
        if (!sessionData.gracePeriodTimeout) {
          console.log(`[SessionManager] ${docName}: Starting 2-minute disconnect grace period.`);
          sessionData.gracePeriodTimeout = setTimeout(() => {
            this.terminateSession(docName, 'Your peer did not connect within the time limit. Returning to dashboard', droppedUser, 'Timeout');
          }, GRACE_PERIOD);
        }
      }
    });
  }

  static resetInactivityTimer(docName: string) {
    const sessionData = activeSessions.get(docName);
    if (!sessionData) return;

    if (sessionData.inactivityTimeout) {
      clearTimeout(sessionData.inactivityTimeout);
    }

    sessionData.inactivityTimeout = setTimeout(() => {
      console.log(`[SessionManager] ${docName}: 30 minutes of inactivity. Terminating.`);
      this.terminateSession(docName, 'Session timed out due to 30 minutes of inactivity.', 'system', 'Inactive');
    }, INACTIVITY_TIMEOUT);
  }

  static async terminateSession(docName: string, reason: string, terminatedBy?: string, terminationReason?: string) {
    const sessionData = activeSessions.get(docName);
    console.log(`[SessionManager] Terminating session ${docName}. Reason: ${reason}`);

    if (sessionData) {
      sessionData.terminating = true;
      if (sessionData.gracePeriodTimeout) {
        clearTimeout(sessionData.gracePeriodTimeout);
        sessionData.gracePeriodTimeout = undefined;
      }
      if (sessionData.inactivityTimeout) {
        clearTimeout(sessionData.inactivityTimeout);
        sessionData.inactivityTimeout = undefined;
      }
      if (sessionData.cleanup) sessionData.cleanup();

      // broadcast termination CRDT signal directly to clients
      sessionData.ydoc.getMap('sys').set('status', 'terminated');
      sessionData.ydoc.getMap('sys').set('reason', reason);
      sessionData.ydoc.getMap('sys').set('terminateReason', terminationReason || 'Unknown');
    }

    // 1. Force the database status to terminated FIRST to guarantee lock release
    try {
      await SessionManager.prisma.session.update({
        where: { id: docName },
        data: {
          status: 'terminated',
          terminatedAt: new Date(),
          terminateReason: terminationReason || 'Unknown',
          terminatedBy: terminatedBy || null,
        },
      });
    } catch (e) {
      console.error(`[SessionManager] Main DB status update failed. Emitting fallback update for ${docName}.`, e);
      try {
        await SessionManager.prisma.session.update({
          where: { id: docName },
          data: { status: 'terminated' }
        });
      } catch (e2) {
        console.error(`[SessionManager] FATAL fallback DB status update failed!`, e2);
      }
    }

    if (sessionData) {
      // 2. Persist the final document CRDT buffer securely immediately after lock
      try {
        const state = SessionManager.Yjs.encodeStateAsUpdate(sessionData.ydoc);
        await SessionManager.prisma.session.update({
          where: { id: docName },
          data: { docState: Buffer.from(state) }
        });
      } catch (e) {
        console.error(`[SessionManager] Flush DB save failed for ${docName}:`, e);
      }

      // wait 1000ms to allow TCP flush to transmit the map updates to actively connected clients
      setTimeout(() => {
        for (const socket of sessionData.connections) {
          socket.close(4000, reason);
        }
        activeSessions.delete(docName);
      }, 1000);
    }
  }
}
