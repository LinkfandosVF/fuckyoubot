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
const YOUTUBE_CHANNEL = 'MrPemmfub';
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

const twitchReader = new tmi.Client({ channels: [TWITCH_CHANNEL.toLowerCase()], connection: { reconnect: true, secure: true } });
twitchReader.connect().catch(e => console.log('Twitch reader:', e.message));
twitchReader.on('connected', () => console.log('Twitch reader connected - listening to', TWITCH_CHANNEL));
twitchReader.on('message', (channel, tags, message) => {
  const ts = tags['tmi-sent-ts'] ? parseInt(tags['tmi-sent-ts']) : null;
  addMessage('twitch', tags['display-name'] || tags.username, message, null, ts);
});

let twitchWriter = null;
if (TWITCH_BOT_USERNAME && TWITCH_BOT_OAUTH) {
  twitchWriter = new tmi.Client({ channels: [TWITCH_CHANNEL.toLowerCase()], connection: { reconnect: true, secure: true }, identity: { username: TWITCH_BOT_USERNAME, password: TWITCH_BOT_OAUTH } });
  twitchWriter.connect().catch(e => console.log('Twitch writer:', e.message));
  twitchWriter.on('connected', () => console.log('Twitch writer connected'));
  console.log('Twitch bot enabled:', TWITCH_BOT_USERNAME);
} else console.log('Twitch bot: none (read-only)');

function sendToTwitch(source, username, text) {
  if (source === 'twitch' || !twitchWriter) return;
  const prefix = source === 'youtube' ? 'YT' : 'Chat';
  twitchWriter.say(TWITCH_CHANNEL.toLowerCase(), `[${prefix}] ${username}: ${text}`).catch(e => console.log('Twitch say:', e.message));
}

let ytChannelId = null;
let ytLiveChatId = null;
let ytNextPage = '';
let ytPollTimer = null;

async function findYTChannel() {
  if (!YOUTUBE_API_KEY) return;
  try {
    const r = await axios.get('https://www.googleapis.com/youtube/v3/search', { params: { part: 'snippet', q: YOUTUBE_CHANNEL, type: 'channel', key: YOUTUBE_API_KEY } });
    ytChannelId = r.data.items?.[0]?.id?.channelId;
    if (ytChannelId) console.log('YouTube channel:', ytChannelId);
  } catch (e) { console.log('YouTube channel lookup failed:', e.message); }
}

async function checkYTLive() {
  if (!YOUTUBE_API_KEY || !ytChannelId) return;
  if (ytLiveChatId) return; // already connected
  try {
    const liveRes = await axios.get('https://www.googleapis.com/youtube/v3/search', { params: { part: 'id', channelId: ytChannelId, eventType: 'live', type: 'video', key: YOUTUBE_API_KEY } });
    const videoId = liveRes.data.items?.[0]?.id?.videoId;
    if (!videoId) return;
    const vidRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', { params: { part: 'liveStreamingDetails', id: videoId, key: YOUTUBE_API_KEY } });
    ytLiveChatId = vidRes.data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!ytLiveChatId) return;
    console.log('YouTube live chat connected');

    try {
      const initRes = await axios.get('https://www.googleapis.com/youtube/v3/liveChat/messages', { params: { part: 'snippet,authorDetails', liveChatId: ytLiveChatId, key: YOUTUBE_API_KEY } });
      ytNextPage = initRes.data.nextPageToken || '';
      const items = (initRes.data.items || []).slice(-10);
      for (const item of items) addMessage('youtube', item.authorDetails.displayName, item.snippet.displayMessage, null, new Date(item.snippet.publishedAt).getTime());
      console.log('YouTube backfill:', items.length, 'messages');
    } catch {}

    if (ytPollTimer) clearInterval(ytPollTimer);
    ytPollTimer = setInterval(async () => {
      if (!ytLiveChatId) return;
      try {
        const res = await axios.get('https://www.googleapis.com/youtube/v3/liveChat/messages', { params: { part: 'snippet,authorDetails', liveChatId: ytLiveChatId, pageToken: ytNextPage, key: YOUTUBE_API_KEY } });
        ytNextPage = res.data.nextPageToken || '';
        for (const item of res.data.items || []) addMessage('youtube', item.authorDetails.displayName, item.snippet.displayMessage, null, new Date(item.snippet.publishedAt).getTime());
      } catch {}
    }, 5000);
  } catch {}
}

findYTChannel().then(() => {
  checkYTLive();
  setInterval(checkYTLive, 60000); // recheck every 60s for stream start
});

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
