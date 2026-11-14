import { greeting } from '../src/greeting.ts';

// A check only the web team runs: web/checkride.config.json declares it.
if (!greeting('web').endsWith('web')) {
  console.error(`greeting('web') is ${JSON.stringify(greeting('web'))}, which doesn't name who it greets`);
  process.exit(1);
}
