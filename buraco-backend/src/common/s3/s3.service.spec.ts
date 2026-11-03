import { S3Service, SIGNED_URL_TTL_SECONDS } from './s3.service';

// Voice messages used to be stored and handed out as permanent public S3 URLs. They are now
// private objects: the database keeps the key, and readers get a short-lived signed link.
const BUCKET = 'buraco-game-assets';

function service(bucket = BUCKET) {
  const values: Record<string, string> = {
    aws_region: 'ap-south-1',
    aws_access_key_id: 'AKIAEXAMPLEEXAMPLE00',
    aws_secret_access_key: 'example-secret-key-for-signing-tests-only',
    aws_s3_bucket: bucket,
  };
  const sysConfig = { get: jest.fn(async (k: string, fallback: string) => values[k] ?? fallback) };
  const config = { get: jest.fn(() => undefined) };
  return new S3Service(config as any, sysConfig as any);
}

describe('S3Service.keyOf', () => {
  it('passes a bare key through', () => {
    expect(S3Service.keyOf('voice-messages/c/1.m4a', BUCKET)).toBe('voice-messages/c/1.m4a');
  });

  it('extracts the key from a legacy public URL of our bucket', () => {
    expect(S3Service.keyOf(`https://${BUCKET}.s3.ap-south-1.amazonaws.com/voice-messages/c/1.m4a`, BUCKET))
      .toBe('voice-messages/c/1.m4a');
  });

  it('refuses URLs that point anywhere else', () => {
    expect(S3Service.keyOf('https://evil.example/voice.m4a', BUCKET)).toBeNull();
    expect(S3Service.keyOf('https://other-bucket.s3.ap-south-1.amazonaws.com/x.m4a', BUCKET)).toBeNull();
  });
});

describe('S3Service.signUrls', () => {
  it('signs each key with an expiry and no permanent public link', async () => {
    const links = await service().signUrls(['voice-messages/c/1.m4a', 'voice-messages/c/1.m4a']);
    const url = new URL(links.get('voice-messages/c/1.m4a')!);

    expect(links.size).toBe(1);
    expect(url.hostname).toBe(`${BUCKET}.s3.ap-south-1.amazonaws.com`);
    expect(url.pathname).toBe('/voice-messages/c/1.m4a');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(SIGNED_URL_TTL_SECONDS));
  });

  it('leaves values it cannot sign unchanged', async () => {
    const links = await service().signUrls(['https://evil.example/voice.m4a']);
    expect(links.get('https://evil.example/voice.m4a')).toBe('https://evil.example/voice.m4a');
  });

  it('leaves keys unchanged when no bucket is configured', async () => {
    const links = await service('').signUrls(['voice-messages/c/1.m4a']);
    expect(links.get('voice-messages/c/1.m4a')).toBe('voice-messages/c/1.m4a');
  });

  it('returns an empty map for no input', async () => {
    expect((await service().signUrls([])).size).toBe(0);
  });
});
