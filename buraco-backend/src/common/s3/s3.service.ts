import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SystemConfigService } from '../system-config/system-config.service';

/** How long a signed download link stays valid. Clients re-fetch history to get fresh ones. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

@Injectable()
export class S3Service {
  constructor(
    private config: ConfigService,
    private sysConfig: SystemConfigService,
  ) {}

  private async getClient(): Promise<{ client: S3Client; bucket: string; region: string }> {
    const [region, accessKeyId, secretAccessKey, bucket] = await Promise.all([
      this.sysConfig.get('aws_region', this.config.get<string>('aws.region') ?? 'us-east-1'),
      this.sysConfig.get('aws_access_key_id', this.config.get<string>('aws.accessKeyId') ?? ''),
      this.sysConfig.get('aws_secret_access_key', this.config.get<string>('aws.secretAccessKey') ?? ''),
      this.sysConfig.get('aws_s3_bucket', this.config.get<string>('aws.s3Bucket') ?? ''),
    ]);
    const client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
    return { client, bucket, region };
  }

  /** Upload and return the object's public URL (avatars and other public assets). */
  async upload(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const { client, bucket, region } = await this.getClient();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  }

  /** Upload a private object and return its key; hand it out later only through signUrls(). */
  async uploadPrivate(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const { client, bucket } = await this.getClient();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
    return key;
  }

  /**
   * Temporary download links for stored objects, keyed by the stored value.
   * Accepts a bare key or a legacy full `https://<bucket>.s3.<region>.amazonaws.com/<key>` URL.
   * Values that cannot be signed (no bucket configured, foreign URL) map to themselves.
   */
  async signUrls(stored: string[], ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(stored.filter(Boolean))];
    if (unique.length === 0) return out;

    const { client, bucket } = await this.getClient();
    await Promise.all(
      unique.map(async (value) => {
        const key = bucket ? S3Service.keyOf(value, bucket) : null;
        if (!key) {
          out.set(value, value);
          return;
        }
        out.set(value, await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds }));
      }),
    );
    return out;
  }

  /** Object key for a stored value, or null if it points somewhere other than our bucket. */
  static keyOf(value: string, bucket: string): string | null {
    if (!/^https?:\/\//i.test(value)) return value.replace(/^\/+/, '') || null;
    try {
      const url = new URL(value);
      if (!url.hostname.startsWith(`${bucket}.s3.`) || !url.hostname.endsWith('.amazonaws.com')) return null;
      return decodeURIComponent(url.pathname.replace(/^\/+/, '')) || null;
    } catch {
      return null;
    }
  }
}
