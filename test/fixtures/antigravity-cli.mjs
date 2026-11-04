// Local protocol double: never contacts Google or sends QQ messages.
const mode = process.argv[2];
let input = '';
// A real stream-json peer can process the turn while stdin remains open.
await new Promise(resolve => {
  const read = chunk => {
    input += chunk;
    if (input.includes('\n')) { process.stdin.removeListener('data', read); resolve(); }
  };
  process.stdin.on('data', read);
});
const prompt = JSON.parse(input).message.content;
if (!prompt.includes('messages')) process.exit(3);
process.stdout.write(JSON.stringify({ event: 'init', init: { tools: ['run_command'], permission_mode: mode === 'unsafe' ? 'always-proceed' : 'strict' } }) + '\n');
if (mode === 'tool') process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command' } }) + '\n');
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'bad') process.stdout.write('not json\n');
else if (mode === 'exit') { process.stderr.write('secret diagnostic'); process.exit(7); }
else if (mode === 'large') process.stdout.write('x'.repeat(9 * 1024 * 1024));
else {
  const result = { status: 'SUCCESS', structured_output: {
    content: '你好🌸', tool_calls: [{ name: 'send_message', arguments: '{"text":"你好"}' }]
  }, usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, cache_read_tokens: 3 } };
  const bytes = Buffer.from(JSON.stringify({ event: 'result', result }) + '\n');
  // Deliberately split the first Chinese character across pipe chunks.
  const cut = bytes.indexOf(Buffer.from('你')) + 1;
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 10);
}
