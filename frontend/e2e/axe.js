// One accessibility scan per main screen (ADR-0087). Callers first wait for the screen itself; the scan then waits for
// web fonts and every finite entrance animation to settle, so the screen is judged at rest under a busy parallel run.
import AxeBuilder from '@axe-core/playwright';

export async function accessibilityViolations(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
  });
  return (await new AxeBuilder({ page }).analyze()).violations;
}
