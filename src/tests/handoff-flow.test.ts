/**
 * Integration-style test for the WhatsApp human-handoff + pause flow.
 *
 * The webhook receiver makes too many DB calls + LLM calls to exercise as
 * a unit test, so we test the small pieces independently:
 *   1. extractInbound surfaces fromMe + messageId
 *   2. sent-ids cache distinguishes our sends from human sends
 *   3. The decision logic (sentByUs ? echo : human-handoff)
 */
import { test, expect, beforeEach } from 'bun:test';
import { extractInbound } from '~/whatsapp/evolution';
import { recordSentId, isSentByUs, _resetForTests } from '~/whatsapp/sent-ids';

beforeEach(() => _resetForTests());

test('extractInbound surfaces fromMe=true and message ID for outbound echoes', () => {
  const payload = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true, id: 'msg_OUR_send_001' },
      message: { conversation: 'Olá! Bem-vindo!' },
      pushName: 'Loja',
    },
  };
  const inbound = extractInbound(payload);
  expect(inbound).not.toBeNull();
  expect(inbound!.fromMe).toBe(true);
  expect(inbound!.messageId).toBe('msg_OUR_send_001');
  expect(inbound!.text).toBe('Olá! Bem-vindo!');
});

test('extractInbound surfaces fromMe=true for human-typed messages too', () => {
  const payload = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true, id: 'msg_HUMAN_typed_xyz' },
      message: { conversation: 'oi gente, eu falo a partir daqui' },
      pushName: 'Dono',
    },
  };
  const inbound = extractInbound(payload);
  expect(inbound!.fromMe).toBe(true);
  expect(inbound!.messageId).toBe('msg_HUMAN_typed_xyz');
});

test('extractInbound surfaces fromMe=false for customer messages (the original path)', () => {
  const payload = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5511888888888@s.whatsapp.net', fromMe: false, id: 'msg_CUSTOMER_001' },
      message: { conversation: 'tem o produto X?' },
      pushName: 'Maria',
    },
  };
  const inbound = extractInbound(payload);
  expect(inbound!.fromMe).toBe(false);
  expect(inbound!.text).toBe('tem o produto X?');
});

test('handoff decision: our sends are recognized by ID, human sends are not', () => {
  // Agent sends a reply — record the ID we got back from sendText.
  recordSentId('msg_OUR_send_001');

  // Now Evolution echoes our send via webhook. We should recognize it.
  expect(isSentByUs('msg_OUR_send_001')).toBe(true);

  // A different ID arrives (human typed on phone). Cache miss → handoff.
  expect(isSentByUs('msg_HUMAN_typed_xyz')).toBe(false);
});

test('group chats are still dropped (we only handle 1:1 conversations)', () => {
  const payload = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5511999999999-1234567890@g.us', fromMe: false, id: 'g1' },
      message: { conversation: 'oi grupo' },
    },
  };
  expect(extractInbound(payload)).toBeNull();
});

test('non-message events (reactions, edits) return null', () => {
  expect(extractInbound({ event: 'connection.update', data: {} })).toBeNull();
  expect(extractInbound({ event: 'messages.upsert', data: {
    key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'r1' },
    message: { reactionMessage: { key: {}, text: '👍' } }, // unsupported
  }})).toBeNull();
});
