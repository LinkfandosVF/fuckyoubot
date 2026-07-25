const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1530664952317214770/BffXVgVSVWyU7oG-AVlgTDit2_i5_hB_8JipK9Fq8FHaL3I_kMaCk-3tAwfOoCprj_qk';
const TWITCH_CHANNEL = 'mrpemmfub';
const YOUTUBE_CHANNEL = '@MrPemmfub';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

const messages = [];
let msgId = 0;

const ZW = { 0: '\u200B', 1: '\u200C' };
const ZW_REV = { '\u200B': '0', '\u200C': '1' };

function encodeMeta(obj) {
  const str = JSON.stringify(obj);
  let bits = '';
  for (let i = 0; i < str.length; i++)
    bits += str.charCodeAt(i).toString(2).padStart(16, '0');
  let zw = '';
  for (const b of bits) zw += b === '1' ? ZW[1] : ZW[0];
  return '\u200D' + zw + '\u200D';
}

function decodeMeta(text) {
  const start = text.indexOf('\u200D');
  const end = text.lastIndexOf('\u200D');
  if (start === -1 || end <= start) return null;
  const zw = text.slice(start + 1, end);
  let bits = '';
  for (const ch of zw) if (ZW_REV[ch] !== undefined) bits += ZW_REV[ch];
  let str = '';
  for (let i = 0; i < bits.length; i += 16) {
    const chunk = bits.slice(i, i + 16);
    if (chunk.length < 16) break;
    str += String.fromCharCode(parseInt(chunk, 2));
  }
  try { return JSON.parse(str); } catch { return null; }
}

function stripMeta(text) {
  const start = text.indexOf('\u200D');
  if (start === -1) return text;
  const end = text.lastIndexOf('\u200D');
  if (end === -1 || end <= start) return text;
  return text.slice(0, start) + text.slice(end + 1);
}

async function sendToDiscord(source, username, text, replyTo, timestamp) {
  const ts = Math.floor((timestamp || Date.now()) / 1000);
  const tsLine = `-# <t:${ts}:R>`;
  let displayText, webhookUser;
  const meta = { u: username, s: source, t: ts * 1000 };

  if (source === 'twitch') { displayText = `[Twitch] ${username}: ${text}`; webhookUser = 'Twitch'; }
  else if (source === 'youtube') { displayText = `[YouTube] ${username}: ${text}`; webhookUser = 'YouTube'; }
  else { displayText = text; webhookUser = username; }

  if (replyTo) {
    meta.r = { u: replyTo.username, m: replyTo.message };
    displayText = `> **${replyTo.username}**: ${replyTo.message}\n\n${displayText}`;
  }

  try { await axios.post(DISCORD_WEBHOOK, { content: displayText + '\n' + tsLine + encodeMeta(meta), username: webhookUser }); }
  catch (e) { console.log('Discord webhook failed:', e.message); }
}

function addMessage(source, username, text, replyTo = null, timestamp = null) {
  const id = ++msgId;
  const ts = timestamp || Date.now();
  const msg = { id, source, username, message: text, timestamp: ts, replyTo };
  messages.push(msg);
  if (messages.length > 500) messages.shift();
  io.emit('message', msg);
  sendToDiscord(source, username, text, replyTo, ts);
  sendToTwitch(source, username, text);
}

const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME || '';
const TWITCH_BOT_OAUTH = process.env.TWITCH_BOT_OAUTH || '';

function sendToTwitch(source, username, text) {
  if (source === 'twitch' || !TWITCH_BOT_USERNAME || !TWITCH_BOT_OAUTH) return;
  if (!twitchClient.readyState || twitchClient.readyState !== 'OPEN') { console.log('Twitch bot not connected'); return; }
  const prefix = source === 'youtube' ? 'YT' : 'Chat';
  twitchClient.say(TWITCH_CHANNEL.toLowerCase(), `[${prefix}] ${username}: ${text}`).catch(e => console.log('Twitch say:', e.message));
}

const twitchClient = new tmi.Client({
  channels: [TWITCH_CHANNEL.toLowerCase()],
  connection: { reconnect: true, secure: true },
  identity: TWITCH_BOT_USERNAME && TWITCH_BOT_OAUTH ? { username: TWITCH_BOT_USERNAME, password: TWITCH_BOT_OAUTH } : undefined
});
twitchClient.connect().catch(e => console.log('Twitch:', e.message));
twitchClient.on('message', (channel, tags, message) => {
  const ts = tags['tmi-sent-ts'] ? parseInt(tags['tmi-sent-ts']) : null;
  addMessage('twitch', tags['display-name'] || tags.username, message, null, ts);
});

let ytInterval = null;
async function setupYouTube() {
  if (!YOUTUBE_API_KEY) { console.log('No YOUTUBE_API_KEY set, YouTube chat disabled'); return; }
  try {
    const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: YOUTUBE_CHANNEL, type: 'channel', key: YOUTUBE_API_KEY }
    });
    const channelId = searchRes.data.items?.[0]?.id?.channelId;
    if (!channelId) return;
    const liveRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'id', channelId, eventType: 'live', type: 'video', key: YOUTUBE_API_KEY }
    });
    const videoId = liveRes.data.items?.[0]?.id?.videoId;
    if (!videoId) return;
    const vidRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'liveStreamingDetails', id: videoId, key: YOUTUBE_API_KEY }
    });
    const liveChatId = vidRes.data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!liveChatId) return;
    console.log('YouTube live chat connected');

    let nextPageToken = '';
    try {
      const initRes = await axios.get('https://www.googleapis.com/youtube/v3/liveChat/messages', {
        params: { part: 'snippet,authorDetails', liveChatId, key: YOUTUBE_API_KEY }
      });
      nextPageToken = initRes.data.nextPageToken || '';
      for (const item of initRes.data.items || []) {
        const ts = new Date(item.snippet.publishedAt).getTime();
        addMessage('youtube', item.authorDetails.displayName, item.snippet.displayMessage, null, ts);
      }
    } catch {}

    ytInterval = setInterval(async () => {
      try {
        const res = await axios.get('https://www.googleapis.com/youtube/v3/liveChat/messages', {
          params: { part: 'snippet,authorDetails', liveChatId, pageToken: nextPageToken, key: YOUTUBE_API_KEY }
        });
        nextPageToken = res.data.nextPageToken || '';
        for (const item of res.data.items || []) {
          const ts = new Date(item.snippet.publishedAt).getTime();
          addMessage('youtube', item.authorDetails.displayName, item.snippet.displayMessage, null, ts);
        }
      } catch {}
    }, 5000);
  } catch (e) { console.log('YouTube setup failed:', e.message); }
}
setupYouTube();

io.on('connection', (socket) => {
  socket.emit('history', messages);
  socket.on('sendMessage', (data) => {
    addMessage(data.source || 'discord', data.username, data.message, data.replyTo || null);
  });
  socket.on('command', (data) => {
    if (data.command === 'nick' && data.args) socket.emit('nickChanged', data.args);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
