import 'dotenv/config';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import { ethers } from 'ethers';
import type { TypedDataField } from 'ethers';

const ALLOWED_ORIGINS = ['http://localhost:5173', 'https://evm-realtimechat-server.onrender.com'];
const SIWE_STATEMENT = 'Sign in to EVM RealTimeChat';
const SIWE_VERSION = '1';
const NONCE_TTL_MS = 5 * 60 * 1000;
const TYPE_DATA_TYPES = {
	SignIn: [
		{ name: 'domain', type: 'string' },
		{ name: 'address', type: 'address' },
		{ name: 'statement', type: 'string' },
		{ name: 'uri', type: 'string' },
		{ name: 'version', type: 'string' },
		{ name: 'chainId', type: 'uint256' },
		{ name: 'nonce', type: 'string' },
		{ name: 'issuedAt', type: 'string' },
		{ name: 'expirationTime', type: 'string' }
	]
} satisfies Record<string, TypedDataField[]>;

type NonceChallenge = {
	address: string;
	chainId: number;
	domain: string;
	uri: string;
	issuedAt: string;
	expirationTime: string;
	consumed: boolean;
};

const nonceChallenges = new Map<string, NonceChallenge>();

// Websocket Server Setup
const httpServer = createServer((req, res) => {
	const method = req.method ?? 'GET';
	const host = req.headers.host ?? 'localhost:10000';
	const requestUrl = new URL(req.url ?? '/', `http://${host}`);
	const origin = req.headers.origin;
	const isAllowedOrigin = origin && ALLOWED_ORIGINS.includes(origin);

	if (isAllowedOrigin) {
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Access-Control-Allow-Credentials', 'true');
	}

	if (method === 'OPTIONS') {
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
		res.statusCode = 204;
		res.end();
		return;
	}

	if (method === 'GET' && requestUrl.pathname === '/auth/nonce') {
		const addressRaw = requestUrl.searchParams.get('address');
		const chainIdRaw = requestUrl.searchParams.get('chainId');

		if (!addressRaw || !chainIdRaw) {
			res.statusCode = 400;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ error: 'address and chainId are required' }));
			return;
		}

		const chainId = Number(chainIdRaw);
		if (!Number.isInteger(chainId) || chainId <= 0) {
			res.statusCode = 400;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ error: 'Invalid chainId' }));
			return;
		}

		let address: string;
		try {
			address = ethers.getAddress(addressRaw).toLowerCase();
		} catch {
			res.statusCode = 400;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ error: 'Invalid address' }));
			return;
		}

		const now = Date.now();
		const issuedAt = new Date(now).toISOString();
		const expirationTime = new Date(now + NONCE_TTL_MS).toISOString();
		const nonce = randomBytes(16).toString('hex');
		const originUrl = origin ? new URL(origin) : new URL(`http://${host}`);
		const domain = originUrl.hostname;
		const uri = originUrl.origin;

		nonceChallenges.set(nonce, {
			address,
			chainId,
			domain,
			uri,
			issuedAt,
			expirationTime,
			consumed: false
		});

		res.statusCode = 200;
		res.setHeader('Content-Type', 'application/json');
		res.end(
			JSON.stringify({
				typedData: {
					domain: {
						name: 'EVM RealTimeChat',
						version: SIWE_VERSION,
						chainId
					},
					types: TYPE_DATA_TYPES,
					primaryType: 'SignIn',
					message: {
						domain,
						address,
						statement: SIWE_STATEMENT,
						uri,
						version: SIWE_VERSION,
						chainId,
						nonce,
						issuedAt,
						expirationTime
					}
				}
			})
		);
		return;
	}

	res.statusCode = 404;
	res.end('Not Found');
});

const io = new Server(httpServer, {
	cors: {
		origin: ALLOWED_ORIGINS,
		credentials: true
	}
});

/**
 * Presence
 * address -> active socket IDs
 * Source of truth for online/offline
 */
const addressToSockets = new Map<string, Set<string>>();

io.on('connection', (socket: Socket) => {
	const authPayload = socket.handshake.auth as {
		address?: string;
		signature?: string;
		typedData?: {
			domain?: { name?: string; version?: string; chainId?: number };
			message?: {
				nonce?: string;
				chainId?: number;
				issuedAt?: string;
				expirationTime?: string;
			};
		};
	};
	const addressRaw = authPayload.address;
	const signature = authPayload.signature;
	const nonce = authPayload.typedData?.message?.nonce;

	if (!addressRaw || !signature || !nonce) {
		return socket.disconnect(true);
	}

	let address: string;
	try {
		address = ethers.getAddress(addressRaw).toLowerCase();
	} catch {
		return socket.disconnect(true);
	}

	const challenge = nonceChallenges.get(nonce);
	if (!challenge || challenge.consumed) {
		return socket.disconnect(true);
	}

	if (challenge.expirationTime <= new Date().toISOString()) {
		nonceChallenges.delete(nonce);
		return socket.disconnect(true);
	}

	if (challenge.address !== address) {
		return socket.disconnect(true);
	}

	try {
		const recoveredAddress = ethers
			.verifyTypedData(
				{
					name: 'EVM RealTimeChat',
					version: SIWE_VERSION,
					chainId: challenge.chainId
				},
				TYPE_DATA_TYPES,
				{
					domain: challenge.domain,
					address: challenge.address,
					statement: SIWE_STATEMENT,
					uri: challenge.uri,
					version: SIWE_VERSION,
					chainId: challenge.chainId,
					nonce,
					issuedAt: challenge.issuedAt,
					expirationTime: challenge.expirationTime
				},
				signature
			)
			.toLowerCase();

		if (recoveredAddress !== address) {
			return socket.disconnect(true);
		}
	} catch {
		return socket.disconnect(true);
	}

	challenge.consumed = true;
	socket.data.address = address;

	// -------------------------
	// PRESENCE REGISTER
	// -------------------------
	let sockets = addressToSockets.get(address);
	const isFirstConnection = !sockets;

	if (!sockets) {
		sockets = new Set();
		addressToSockets.set(address, sockets);
	}

	sockets.add(socket.id);

	if (isFirstConnection) {
		console.log('USER ONLINE:', address);
		socket.broadcast.emit('presence:online', { address });
	}

	// snapshot to newly connected client
	socket.emit('presence:snapshot', {
		users: Array.from(addressToSockets.keys()).map((address) => ({
			address,
			online: true
		}))
	});

	socket.on('dm:send', ({ to, body }) => {
		const from = socket.data.address;
		if (!to || !body) return;

		const msg = {
			from,
			to,
			body,
			ts: Date.now()
		};

		// send to recipient sockets
		const recipientSockets = addressToSockets.get(to.toLowerCase());
		if (recipientSockets) {
			for (const id of recipientSockets) {
				io.to(id).emit('dm:message', msg);
			}
		}

		// echo back to sender
		socket.emit('dm:message', msg);
	});

	// -------------------------
	// DISCONNECT
	// -------------------------
	socket.on('disconnect', () => {
		const sockets = addressToSockets.get(address);
		if (!sockets) return;

		sockets.delete(socket.id);

		if (sockets.size === 0) {
			addressToSockets.delete(address);
			console.log('USER OFFLINE:', address);
			io.emit('presence:offline', { address });
		}
	});
});

httpServer.listen(10000, '0.0.0.0', () => {
	console.log(`evm-realtimechat-server started`);
});
