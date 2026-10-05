import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyTargetFor, resolveChatRecipient } from '../src/lib/chatReply';

const ME = 'teacher-p';

test('Reply targets the student who wrote to the teacher', () => {
  assert.equal(
    replyTargetFor({ scope: 'TEACHER', senderParticipantId: 's1', recipientParticipantId: null, senderRole: 'STUDENT' }, ME),
    's1'
  );
});

test('Reply on my own DM continues with its recipient', () => {
  assert.equal(
    replyTargetFor({ scope: 'DIRECT', senderParticipantId: ME, recipientParticipantId: 's2', senderRole: 'TEACHER' }, ME),
    's2'
  );
});

test('Broadcasts have no reply target', () => {
  assert.equal(
    replyTargetFor({ scope: 'BROADCAST', senderParticipantId: ME, recipientParticipantId: null, senderRole: 'TEACHER' }, ME),
    null
  );
});

test('Recipient sticks while the student is in class, else Everyone', () => {
  const ids = new Set(['s1', 's2']);
  assert.equal(resolveChatRecipient('s1', ids), 's1');
  assert.equal(resolveChatRecipient('gone', ids), 'all');
  assert.equal(resolveChatRecipient('all', ids), 'all');
});
