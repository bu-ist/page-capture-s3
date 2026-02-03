// src/run-tests-2.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
// --- Mocks ---------------------------------------------------------

// CJS-style: page-capture.js uses `const scrape = require('website-scraper')`
const scrapeMock = vi.fn();
const uploadDirMock = vi.fn();
const delMock = vi.fn();
// Mock `website-scraper` as a plain function (CommonJS default export)
vi.mock('website-scraper', () => {
  return {
    __esModule: true,
    default: scrapeMock,
  };
});
// Mock `s3-node-client` as an object with createClient().uploadDir()
vi.mock('s3-node-client', () => {
  return {
    __esModule: true,
    createClient: () => ({
      uploadDir: (...args) => {
        // record call for assertions
        uploadDirMock(...args);
        // return an EventEmitter because code calls .on('error') and .on('end')
        const emitter = new EventEmitter();
        // we *could* emit 'end' here asynchronously if your code waits on it,
        // but from the snippet you shared the callback is invoked regardless.
        queueMicrotask(() => emitter.emit('end'));
        return emitter;
      },
    }),
  };
});

// Mock `del` to use delMock
vi.mock('del', () => ({
  __esModule: true,
  default: (...args) => delMock(...args),
}));

// --- Tests ---------------------------------------------------------

describe('pageCapture Lambda', () => {
  beforeEach(() => {
    //vi.resetModules();

    scrapeMock.mockReset();
    uploadDirMock.mockReset();
    delMock.mockReset();
    delMock.mockResolvedValue(['/tmp/page-capture/file.html']);

    // Make sure env vars are set *before* we import page-capture.js
    process.env.CAPTURE_URL = 'https://example.com/page';
    process.env.SUBDIR_PREFIX = 'home';
    process.env.S3_BUCKET_NAME = 'homepage-capture-s3-test-files';
    process.env.S3_PATH = 'captures/';
  });
  
  it('captures a page from SQS trigger and starts upload', async () => {
    const { pageCapture } = await import('./page-capture.js');

    // Arrange
    const event = {
      Records: [
        {
          messageId: 'abc-123',
        },
      ],
    };

    // Scraper returns a successful capture
    scrapeMock.mockResolvedValue([{ saved: true }]);

    // We DO NOT await pageCapture; we rely on the callback instead
    await new Promise((resolve, reject) => {
      const callback = (err, response) => {
        try {
          expect(err).toBeNull();

          // Assert scrape was called once
          expect(scrapeMock).toHaveBeenCalledTimes(1);
          const scrapeOptions = scrapeMock.mock.calls[0][0];

          // URL includes cachebust param
          expect(scrapeOptions.urls[0]).toMatch(
            /^https:\/\/example\.com\/page\?cachebust=\d+$/,
          );

          // uploadDir called with correct bucket/prefix/localDir
          expect(uploadDirMock).toHaveBeenCalledTimes(1);
          const uploadArgs = uploadDirMock.mock.calls[0][0];

          expect(uploadArgs).toEqual(
            expect.objectContaining({
              s3Params: {
                Bucket: 'homepage-capture-s3-test-files',
                Prefix: 'captures/',
              },
              localDir: expect.stringContaining('/tmp/page-capture/capture-'),
            }),
          );

          // Response string contains SQS message id and true status
          expect(response).toContain('Capture status was true');
          expect(response).toContain('SQS message id was abc-123');

          resolve();
        } catch (assertErr) {
          reject(assertErr);
        }
      };

      // Act
      pageCapture(event, {}, callback);
    });
  });
  
  it('returns schedule message when invoked by CloudWatch Events', async () => {
    const { pageCapture } = await import('./page-capture.js');

    const event = {
      source: 'aws.events',
    };

    scrapeMock.mockResolvedValue([{ saved: false }]);

    await new Promise((resolve, reject) => {
      const callback = (err, response) => {
        try {
          expect(err).toBeNull();

          // We don’t really care if upload starts here; just assert the response
          expect(response).toContain('Capture status was false');
          expect(response).toContain('Triggered by a schedule');

          resolve();
        } catch (assertErr) {
          reject(assertErr);
        }
      };

      pageCapture(event, {}, callback);
    });
  });
});
