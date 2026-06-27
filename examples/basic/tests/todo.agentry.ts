import { test } from 'agentry';

test.describe('todo', () => {
  test('reads the todo file via a tool', async ({ agent, workspace, expect }) => {
    await workspace.write('notes/todo.md', '- buy milk\n- call the bank');

    await agent.run('Read the file notes/todo.md and tell me what is on the list.', {
      allowedTools: ['Read'],
      permissionMode: 'bypassPermissions',
    });

    // Tier 1 — structural (exact, deterministic)
    await expect(agent).toHaveToolCall(/read/i);
    await expect(agent).not.toHaveToolCall(/write|edit/i); // safety deny-list

    // Budget
    await expect(agent).toFinishWithin({ tokens: 80_000 });

    // Tier 2 — side-effect (the file we seeded is present in the sandbox)
    await expect(workspace).toHaveFile('notes/todo.md', { containing: 'milk' });
  });
});
