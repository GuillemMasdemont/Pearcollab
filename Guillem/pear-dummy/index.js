import Hyperswarm from 'hyperswarm';
import crypto from 'hypercore-crypto';
import b4a from 'b4a'; // Holepunch's universal buffer library

const swarm = new Hyperswarm();

// 1. Create a 32-byte topic using Holepunch's libraries
const roomName = 'my-super-secret-document-room';
// Convert the string to a buffer, then hash it to guarantee a secure 32-byte key
const topic = crypto.hash(b4a.from(roomName));

console.log('🍐 Pear P2P Node Started!');
console.log('🔍 Announcing to the network and looking for peers...');

// 2. Join the swarm
swarm.join(topic, { client: true, server: true });

// 3. Listen for connections
swarm.on('connection', (socket) => {
  console.log('\n🟢 SUCCESS! A peer has connected directly to you!');

  // Send a greeting using b4a to encode the string
  socket.write(b4a.from('Hello! I am glad we found each other on the network.'));

  // Listen for data
  socket.on('data', (data) => {
    console.log(`💬 Message from peer: ${b4a.toString(data)}`);
  });

  socket.on('close', () => {
    console.log('\n🔴 The peer disconnected.');
  });
  
  socket.on('error', (err) => {
    // Catch errors silently to prevent crashes
  });
});