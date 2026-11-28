const roles = new Set(['link', 'button', 'textbox', 'searchbox', 'tab']);
const actions = new Set(['click', 'fill', 'enter']);

export function validateBrowserSteps(steps) {
  if (!Array.isArray(steps) || steps.length > 8) throw new Error('Expected at most eight browser steps');
  for (const step of steps) {
    if (!step || !roles.has(step.role) || !actions.has(step.action) || typeof step.name !== 'string') {
      throw new Error('Invalid browser control or action');
    }
    if (step.action === 'fill' && (!['textbox', 'searchbox'].includes(step.role) || typeof step.value !== 'string')) {
      throw new Error('Fill requires a text input and string value');
    }
  }
}
