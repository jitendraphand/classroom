import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyTargetFor, resolveChatRecipient, stickyChatRecipient } from '../src/shared/chatReply';

const student = {
  scope: 'TEACHER',
  senderParticipantId: 's1',
  recipientParticipantId: null,
  senderRole: 'STUDENT',
};

test('reply goes to the student who wrote, or to the recipient of the teacher DM', () => {
  assert.equal(replyTargetFor(student, 't1'), 's1');
  assert.equal(
    replyTargetFor(
      { scope: 'DIRECT', senderParticipantId: 't1', recipientParticipantId: 's1', senderRole: 'TEACHER' },
      't1'
    ),
    's1'
  );
  assert.equal(
    replyTargetFor(
      { scope: 'DIRECT', senderParticipantId: 's1', recipientParticipantId: 't1', senderRole: 'STUDENT' },
      't1'
    ),
    's1'
  );
  assert.equal(
    replyTargetFor(
      { scope: 'BROADCAST', senderParticipantId: 's1', recipientParticipantId: null, senderRole: 'STUDENT' },
      't1'
    ),
    null
  );
});

test('Reply sticks: the class view wins over a stale Everyone dropdown', () => {
  assert.equal(stickyChatRecipient('s1', 'all'), 's1');
  assert.equal(stickyChatRecipient('all', 's1'), 'all');
  assert.equal(stickyChatRecipient('', 's1'), 's1');
  assert.equal(stickyChatRecipient('', ''), 'all');
});

test('the recipient stays selected only while that student is in the class', () => {
  assert.equal(resolveChatRecipient('s1', new Set(['s1', 's2'])), 's1');
  assert.equal(resolveChatRecipient('gone', new Set(['s1'])), 'all');
  assert.equal(resolveChatRecipient('all', new Set(['s1'])), 'all');
});
