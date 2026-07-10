/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { BadRequestException } from '@nestjs/common';
import { uuidv7 } from '../../common/util/uuid';
import { TransactionsController } from './transactions.controller';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import type { TransactionsService } from './transactions.service';

describe('TransactionsController', () => {
  const dto = { kind: 'DEPOSIT', targetWalletId: uuidv7(), amountMinor: 100, currency: 'TRY' } as CreateTransactionDto;

  function setup() {
    const service = { post: jest.fn().mockResolvedValue({ id: 'tx1' }) };
    return {
      controller: new TransactionsController(service as unknown as TransactionsService),
      service,
    };
  }

  it('requires an Idempotency-Key header', async () => {
    const { controller } = setup();
    await expect(controller.create(dto, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-UUID Idempotency-Key values', async () => {
    const { controller } = setup();
    await expect(controller.create(dto, 'not-a-uuid')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'Idempotency.KeyInvalid' }),
    });
  });

  it('trims and forwards a valid UUID Idempotency-Key', async () => {
    const { controller, service } = setup();
    const key = uuidv7();
    await expect(controller.create(dto, ` ${key} `)).resolves.toEqual({ id: 'tx1' });
    expect(service.post).toHaveBeenCalledWith(dto, key);
  });
});
