// Playwright adapter for the shared scenarios (ADR-0087): the same factories the preview installs answer the page, and
// anything a scenario does not declare fails closed.
import { createScenario } from './scenarios.js';

export async function routeScenario(page, name = 'ready') {
  const scenario = createScenario(name);
  await page.route('**/api/**', (route) => {
    const request = route.request();
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    const answer = scenario.respond({ method: request.method(), path: new URL(request.url()).pathname, body });
    return route.fulfill(answer
      ? { status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.json) }
      : { status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Not in this scenario.' }) });
  });
  // Every other Admin socket is closed; the scenario's chat socket is registered last, so it takes precedence.
  await page.routeWebSocket(/\/api(?:\/|$)/, (socket) => socket.close({ code: 1008, reason: 'Not in this scenario.' }));
  // Every chat frame the page sends is kept in order, so a test can prove exactly what reached the Team boundary.
  const chatFrames = [];
  await page.routeWebSocket(`**${scenario.chat.path}`, (socket) => {
    socket.onMessage((message) => {
      const frame = JSON.parse(message);
      chatFrames.push(frame);
      for (const reply of scenario.chat.message(frame)) socket.send(JSON.stringify(reply));
    });
  });
  return { ...scenario, chatFrames: () => chatFrames };
}
