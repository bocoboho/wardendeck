import assert from 'node:assert/strict';
import test from 'node:test';
import { stripMentions } from './feishu.js';

test('strips Feishu mention placeholders before the message reaches the agent', () => {
  assert.equal(stripMentions('@_user_1 你好', [{ key: '@_user_1' }]), '你好');
  assert.equal(
    stripMentions('@_user_1 @_user_2 帮我修 bug', [{ key: '@_user_1' }, { key: '@_user_2' }]),
    '帮我修 bug',
  );
  assert.equal(stripMentions('@_user_1', [{ key: '@_user_1' }]), '');
  assert.equal(stripMentions('没有提及', []), '没有提及');
});

test('does not strip text when the placeholder is absent from the message', () => {
  assert.equal(stripMentions('普通消息', [{ key: '@_user_9' }]), '普通消息');
});
