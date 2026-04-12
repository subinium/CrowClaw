export interface BrowserPage {
  goto(url: string): Promise<{ url: string; title: string }>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  goBack(): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  close(): Promise<void>;
}

export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}

export interface PlaywrightInstance {
  chromium: { launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser> };
}

/**
 * PlaywrightBrowserBackend wraps Playwright for real browser automation.
 * Playwright must be installed as an optional dependency (`npm install playwright`).
 * If not installed, all methods throw with a helpful message.
 */
export class PlaywrightBrowserBackend {
  private browser: PlaywrightBrowser | null = null;
  private context: BrowserContext | null = null;
  private page: BrowserPage | null = null;
  private playwright: PlaywrightInstance | null = null;

  async launch(options?: { headless?: boolean }): Promise<void> {
    try {
      // Dynamic import — playwright is optional
      // @ts-expect-error playwright is an optional peer dependency
      const pw = (await import('playwright')) as unknown as PlaywrightInstance;
      this.playwright = pw;
      this.browser = await pw.chromium.launch({ headless: options?.headless ?? true });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
    } catch (error: unknown) {
      throw new Error(
        'Playwright is not installed. Install it with: npm install playwright\n' +
        (error instanceof Error ? error.message : String(error))
      );
    }
  }

  private ensurePage(): BrowserPage {
    if (!this.page) throw new Error('Browser not launched. Call launch() first.');
    return this.page;
  }

  async goto(url: string): Promise<{ url: string; title: string }> {
    const page = this.ensurePage();
    await page.goto(url);
    return { url: page.url(), title: await page.title() };
  }

  async screenshot(options?: { fullPage?: boolean }): Promise<{ data: Buffer; url: string }> {
    const page = this.ensurePage();
    const data = await page.screenshot({ fullPage: options?.fullPage });
    return { data, url: page.url() };
  }

  async click(selector: string): Promise<{ url: string }> {
    const page = this.ensurePage();
    await page.click(selector);
    return { url: page.url() };
  }

  async type(selector: string, text: string): Promise<{ url: string }> {
    const page = this.ensurePage();
    await page.type(selector, text);
    return { url: page.url() };
  }

  async waitFor(selector: string, options?: { timeout?: number }): Promise<{ matched: boolean; url: string }> {
    const page = this.ensurePage();
    try {
      await page.waitForSelector(selector, { timeout: options?.timeout ?? 5000 });
      return { matched: true, url: page.url() };
    } catch {
      return { matched: false, url: page.url() };
    }
  }

  async extract(selector?: string): Promise<{ content: string; url: string }> {
    const page = this.ensurePage();
    const content = selector
      ? await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
      : await page.evaluate(`document.body.innerText`);
    return { content: String(content), url: page.url() };
  }

  async back(): Promise<{ url: string }> {
    const page = this.ensurePage();
    await page.goBack();
    return { url: page.url() };
  }

  async press(key: string): Promise<{ url: string }> {
    const page = this.ensurePage();
    await page.keyboard.press(key);
    return { url: page.url() };
  }

  async snapshot(): Promise<{ text: string; url: string; title: string }> {
    const page = this.ensurePage();
    const text = await page.evaluate(`document.body.innerText`);
    return { text: String(text), url: page.url(), title: await page.title() };
  }

  async consoleMessages(): Promise<string[]> {
    // Note: would need event listener setup during launch for real implementation
    return [];
  }

  async getImages(limit?: number): Promise<Array<{ src: string; alt: string }>> {
    const page = this.ensurePage();
    const images = await page.evaluate(`
      Array.from(document.querySelectorAll('img')).slice(0, ${limit ?? 10}).map(img => ({
        src: img.src,
        alt: img.alt || ''
      }))
    `);
    return images as Array<{ src: string; alt: string }>;
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  isLaunched(): boolean {
    return this.page !== null;
  }
}

/** Singleton browser backend — lazy-initialized on first use */
let sharedBackend: PlaywrightBrowserBackend | null = null;

export async function getOrCreateBrowserBackend(): Promise<PlaywrightBrowserBackend> {
  if (!sharedBackend || !sharedBackend.isLaunched()) {
    sharedBackend = new PlaywrightBrowserBackend();
    await sharedBackend.launch();
  }
  return sharedBackend;
}

export async function closeBrowserBackend(): Promise<void> {
  if (sharedBackend) {
    await sharedBackend.close();
    sharedBackend = null;
  }
}

export function isPlaywrightAvailable(): boolean {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}
