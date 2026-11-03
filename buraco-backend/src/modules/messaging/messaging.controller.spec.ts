import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MAX_VOICE_SECONDS } from './messaging.service';

// Voice upload: membership is checked before anything reaches S3, the length is capped,
// and the duration is rounded because Message.duration is an Int column.
const CONV = '0b7d3c39-5c5e-4b8e-9a52-7f0f0f4c1a01';
const ALICE = 'a1111111-1111-4111-8111-111111111111';

function audio(name = 'clip.m4a', mimetype = 'audio/x-m4a') {
  return { originalname: name, mimetype, buffer: Buffer.from('fake-audio') } as Express.Multer.File;
}

function setup(opts: { member?: boolean } = {}) {
  const messaging = {
    assertCanSend: jest.fn(async () => {
      if (opts.member === false) throw new ForbiddenException('Not a member of this conversation');
      return [ALICE, 'bob'];
    }),
    sendVoiceMessage: jest.fn(async (...args: unknown[]) => ({ id: 'm1', args })),
  };
  const s3 = { uploadPrivate: jest.fn(async (key: string) => key) };
  const controller = new MessagingController(messaging as any, s3 as any);
  return { controller, messaging, s3 };
}

describe('MessagingController.sendVoiceMessage', () => {
  it('uploads privately under the conversation and stores the key', async () => {
    const { controller, messaging, s3 } = setup();
    await controller.sendVoiceMessage(CONV, ALICE, audio(), '3.4');

    const key = s3.uploadPrivate.mock.calls[0][0] as string;
    expect(key).toMatch(new RegExp(`^voice-messages/${CONV}/[0-9a-f-]{36}\\.m4a$`));
    expect(messaging.sendVoiceMessage).toHaveBeenCalledWith(CONV, ALICE, key, 3, [ALICE, 'bob']);
  });

  it('rounds sub-second clips up to 1 second', async () => {
    const { controller, messaging } = setup();
    await controller.sendVoiceMessage(CONV, ALICE, audio(), '0.3');
    expect(messaging.sendVoiceMessage.mock.calls[0][3]).toBe(1);
  });

  it('refuses a non-member before uploading anything', async () => {
    const { controller, s3, messaging } = setup({ member: false });
    await expect(controller.sendVoiceMessage(CONV, ALICE, audio(), '4')).rejects.toBeInstanceOf(ForbiddenException);
    expect(s3.uploadPrivate).not.toHaveBeenCalled();
    expect(messaging.sendVoiceMessage).not.toHaveBeenCalled();
  });

  it(`refuses clips longer than ${MAX_VOICE_SECONDS} seconds`, async () => {
    const { controller, s3 } = setup();
    await expect(controller.sendVoiceMessage(CONV, ALICE, audio(), String(MAX_VOICE_SECONDS + 1))).rejects.toBeInstanceOf(BadRequestException);
    expect(s3.uploadPrivate).not.toHaveBeenCalled();
  });

  it('refuses a missing file, a non-audio file and a bad duration', async () => {
    const { controller, s3 } = setup();
    await expect(controller.sendVoiceMessage(CONV, ALICE, undefined as any, '4')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.sendVoiceMessage(CONV, ALICE, audio('x.exe', 'application/octet-stream'), '4')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.sendVoiceMessage(CONV, ALICE, audio(), 'abc')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.sendVoiceMessage(CONV, ALICE, audio(), '0')).rejects.toBeInstanceOf(BadRequestException);
    expect(s3.uploadPrivate).not.toHaveBeenCalled();
  });

  it('strips odd characters from the file extension', async () => {
    const { controller, s3 } = setup();
    await controller.sendVoiceMessage(CONV, ALICE, audio('clip.M4A?<x>'), '2');
    expect(s3.uploadPrivate.mock.calls[0][0]).toMatch(/\.m4ax$/);
  });
});
