import 'dotenv/config';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';

// Websocket Server Setup
const httpServer = createServer();

const io = new Server(httpServer, {
	cors: {
		origin: [
			'http://localhost:5173',
			`${process.env.LOCAL_IP}:5173`,
			'https://evm-realtimechat-server.onrender.com'
		],
		credentials: true
	}
});

/**
 * Presence
 * address -> active socket IDs
 * Source of truth for online/offline
 */
const addressToSockets = new Map<string, Set<string>>();

/**
 * Chat membership
 * chatId -> set of addresses
 */
const chatRoomMembers = new Map<string, Set<string>>();

io.on('connection', (socket: Socket) => {
	const addressRaw = socket.handshake.auth.address;
	if (!addressRaw) return socket.disconnect(true);

	const address = addressRaw.toLowerCase();
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
	socket.emit('presence:snapshot', {
		users: Array.from(addressToSockets.keys()).map((address) => ({
			address,
			online: true
		}))
	});

	socket.on('dm:send', ({ to, body }) => {
		if (!to || !body) return;

		const from = socket.data.address as string;

		const msg = {
			from,
			to,
			body,
			ts: Date.now()
		};

		// -------------------------
		// SEND TO RECIPIENT (ALL SOCKETS)
		// -------------------------
		const recipientSockets = addressToSockets.get(to.toLowerCase());

		if (recipientSockets) {
			for (const socketId of recipientSockets) {
				io.to(socketId).emit('dm:receive', msg);
			}
		}

		// -------------------------
		// ECHO BACK TO SENDER
		// -------------------------
		socket.emit('dm:sent', msg);
	});

	// -------------------------
	// JOIN CHAT
	// -------------------------
	socket.on('join_chat', ({ chatId }: { chatId: string }) => {
		socket.join(chatId);

		let members = chatRoomMembers.get(chatId);
		if (!members) {
			members = new Set();
			chatRoomMembers.set(chatId, members);
		}

		const before = members.size;
		members.add(address);

		if (before < 2 && members.size >= 2) {
			console.log('CHAT ACTIVE:', chatId, [...members]);
		}
	});

	// -------------------------
	// LEAVE CHAT
	// -------------------------
	socket.on('leave_chat', ({ chatId }: { chatId: string }) => {
		leaveChat(socket, chatId);
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

		for (const [chatId, members] of chatRoomMembers) {
			if (!members.delete(address)) continue;
			if (members.size < 2) {
				chatRoomMembers.delete(chatId);
				console.log('CHAT INACTIVE:', chatId);
			}
		}
	});
});

// -------------------------
// HELPERS
// -------------------------
function leaveChat(socket: Socket, chatId: string) {
	const address = socket.data.address as string;
	socket.leave(chatId);

	const members = chatRoomMembers.get(chatId);
	if (!members) return;

	members.delete(address);
	if (members.size < 2) {
		chatRoomMembers.delete(chatId);
		console.log('CHAT INACTIVE:', chatId);
	}
}

httpServer.listen(10000, '0.0.0.0', () => {
	console.log(`evm-realtimechat-server started`);
});
