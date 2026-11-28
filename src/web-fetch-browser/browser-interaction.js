export async function restrictBrowserRequests(context) {
  await context.route('**/*', route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method()) || !/^https?:\/\//i.test(request.url())) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => socket.close());
}

export async function interactWithPage(page, steps, signal) {
  for (const step of steps) {
    signal.throwIfAborted();
    const control = page.getByRole(step.role, { name: step.name, exact: true });
    if (step.action === 'fill') await control.fill(step.value, { timeout: 2500 });
    else if (step.action === 'click') await control.click({ timeout: 2500 });
    else await control.press('Enter', { timeout: 2500 });
  }
  return { url: page.url(), body: (await page.locator('body').ariaSnapshot()).slice(0, 20_001) };
}
