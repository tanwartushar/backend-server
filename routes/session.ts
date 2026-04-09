import { Router, type Request, type Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { SessionManager } from '../services/SessionManager.js';

const { Pool } = pg;

const router = Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

function singleHeader(req: Request, name: string): string | undefined {
    const v = req.headers[name];
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v[0]?.trim() || undefined;
    return typeof v === 'string' ? v.trim() || undefined : undefined;
}

function matchingBaseUrl(): string {
    return (process.env.MATCHING_SERVICE_URL || 'http://127.0.0.1:3003').replace(/\/$/, '');
}

type MatchRequestJson = {
    status: string;
    userId: string;
    programmingLanguage: string;
    peer?: { userId: string; matchRequestId: string } | null;
};

type VerifiedPair =
    | {
          kind: 'ok';
          sessionId: string;
          user1Id: string;
          user2Id: string;
          language: string;
      }
    | { kind: 'verify_failed' }
    | { kind: 'upstream'; httpStatus: number };

async function verifyMatchFromMatchingService(
    ownMatchRequestId: string,
    expectedPeerRequestId: string,
    authUserId: string,
): Promise<VerifiedPair> {
    const url = `${matchingBaseUrl()}/matching/requests/${encodeURIComponent(ownMatchRequestId)}`;
    let matchingHttp: globalThis.Response;
    try {
        matchingHttp = await fetch(url, { headers: { 'x-user-id': authUserId } });
    } catch (e) {
        console.error('[collaboration] matching service unreachable', e);
        return { kind: 'upstream', httpStatus: 503 };
    }

    if (matchingHttp.status === 404) {
        return { kind: 'verify_failed' };
    }
    if (!matchingHttp.ok) {
        return { kind: 'upstream', httpStatus: matchingHttp.status };
    }

    const data = (await matchingHttp.json()) as MatchRequestJson;
    if (data.userId !== authUserId) {
        return { kind: 'verify_failed' };
    }
    if (data.status !== 'MATCHED' || !data.peer?.userId || !data.peer?.matchRequestId) {
        return { kind: 'verify_failed' };
    }
    if (data.peer.matchRequestId !== expectedPeerRequestId) {
        return { kind: 'verify_failed' };
    }

    const partnerUserId = data.peer.userId;
    const sessionId = [ownMatchRequestId, expectedPeerRequestId].sort().join('-');
    const sortedUsers = [authUserId, partnerUserId].sort();
    const user1Id = sortedUsers[0] as string;
    const user2Id = sortedUsers[1] as string;

    return {
        kind: 'ok',
        sessionId,
        user1Id,
        user2Id,
        language: data.programmingLanguage || 'javascript',
    };
}

// POST /api/collaboration/sessions
router.post('/sessions', async (req: Request, res: Response): Promise<any> => {
    try {
        const authUserId = singleHeader(req, 'x-user-id');
        if (!authUserId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { matchRequestId, peerMatchRequestId, questionId } = req.body as {
            matchRequestId?: string;
            peerMatchRequestId?: string;
            questionId?: string;
        };

        if (!matchRequestId || !peerMatchRequestId || !questionId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const verified = await verifyMatchFromMatchingService(
            matchRequestId,
            peerMatchRequestId,
            authUserId,
        );

        if (verified.kind === 'upstream') {
            return res.status(502).json({ error: 'Matching service unavailable' });
        }
        if (verified.kind === 'verify_failed') {
            return res.status(403).json({ error: 'Match could not be verified' });
        }

        const session = await prisma.session.create({
            data: {
                id: verified.sessionId,
                user1Id: verified.user1Id,
                user2Id: verified.user2Id,
                questionId,
                language: verified.language,
            },
        });

        return res.status(201).json(session);
    } catch (error: any) {
        if (error.code === 'P2002') {
            console.warn('Handling concurrent session creation (P2002)');
            return res.status(409).json({ error: 'Session already exists' });
        }
        console.error('Failed to create session:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/collaboration/sessions/active
router.get('/sessions/active', async (req: Request, res: Response): Promise<any> => {
    try {
        const authUserId = singleHeader(req, 'x-user-id');
        if (!authUserId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const activeSession = await prisma.session.findFirst({
            where: {
                OR: [ { user1Id: authUserId }, { user2Id: authUserId } ],
                status: 'active'
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!activeSession) {
            return res.status(204).send();
        }

        return res.status(200).json(activeSession);
    } catch (error) {
        console.error('Failed to get active session:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/collaboration/sessions/:id
router.get('/sessions/:id', async (req: Request, res: Response): Promise<any> => {
    try {
        const authUserId = singleHeader(req, 'x-user-id');
        if (!authUserId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const rawSessionId = req.params['id'];
        const sessionId =
            typeof rawSessionId === 'string' ? rawSessionId : rawSessionId?.[0];
        if (!sessionId) {
            return res.status(400).json({ error: 'Invalid session id' });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
        });

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (session.user1Id !== authUserId && session.user2Id !== authUserId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        return res.status(200).json(session);
    } catch (error) {
        console.error('Failed to get session:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PATCH /api/collaboration/sessions/:id/terminate
router.patch('/sessions/:id/terminate', async (req: Request, res: Response): Promise<any> => {
    try {
        const authUserId = singleHeader(req, 'x-user-id');
        if (!authUserId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const rawSessionId = req.params['id'];
        const sessionId = typeof rawSessionId === 'string' ? rawSessionId : rawSessionId?.[0];
        
        if (!sessionId) {
            return res.status(400).json({ error: 'Invalid session id' });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId }
        });

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (session.status === 'terminated') {
            return res.status(403).json({ error: 'Session permanently terminated' });
        }

        if (session.user1Id !== authUserId && session.user2Id !== authUserId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        if (session.status === 'terminated') {
             return res.status(200).json({ message: 'Session already terminated' });
        }

        // Delegate to SessionManager to blast the update to WebSockets AND the DB!
        await SessionManager.terminateSession(sessionId, 'User explicitly ended the session.');

        return res.status(200).json({ message: 'Session terminated' });
    } catch (error) {
        console.error('Failed to terminate session:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;