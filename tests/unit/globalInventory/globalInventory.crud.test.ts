/**
 * Unit tests: Global Inventory CRUD handlers
 *
 * Covers:
 *   Suite 1 – POST   /tenant/:tenantId/global-inventory  (create)
 *   Suite 2 – GET    /tenant/:tenantId/global-inventory   (list)
 *   Suite 3 – GET    /tenant/:tenantId/global-inventory/:id (find by ID)
 *   Suite 4 – PUT    /tenant/:tenantId/global-inventory/:id (update)
 *   Suite 5 – DELETE /tenant/:tenantId/global-inventory     (destroy)
 *   Suite 6 – GET    /tenant/:tenantId/global-inventory/autocomplete
 *   Suite 7 – Permission denied scenarios
 *
 * Run: npm run test:unit
 */

import assert from 'assert';
import sinon from 'sinon';
import httpMocks from 'node-mocks-http';

import createHandler from '../../../src/api/inventoryItem/inventoryItemCreate';
import listHandler from '../../../src/api/inventoryItem/inventoryItemList';
import findHandler from '../../../src/api/inventoryItem/inventoryItemFind';
import updateHandler from '../../../src/api/inventoryItem/inventoryItemUpdate';
import destroyHandler from '../../../src/api/inventoryItem/inventoryItemDestroy';
import autocompleteHandler from '../../../src/api/inventoryItem/inventoryItemAutocomplete';
import ApiResponseHandler from '../../../src/api/apiResponseHandler';
import PermissionChecker from '../../../src/services/user/permissionChecker';
import InventoryItemService from '../../../src/services/inventoryItemService';
import Error403 from '../../../src/errors/Error403';

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-uuid-test-1234';
const ITEM_ID = 'item-uuid-test-5678';

const SAMPLE_ITEM = {
  id: ITEM_ID,
  name: 'Radio Motorola',
  type: 'radio',
  brand: 'Motorola',
  modelName: 'GP-3000',
  serialNumber: 'SN-001',
  condition: 'bueno',
  status: 'disponible',
  notes: 'Assigned to north zone',
  expirationDate: '2027-12-31',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildReq(overrides: Record<string, any> = {}) {
  return httpMocks.createRequest({
    currentTenant: { id: TENANT_ID },
    currentUser: { id: 'user-uuid', email: 'admin@test.com' },
    language: 'en',
    params: { tenantId: TENANT_ID },
    ...overrides,
  });
}

function buildRes() {
  return httpMocks.createResponse();
}

// ─── Test Suites ──────────────────────────────────────────────────────────────

describe('Global Inventory CRUD Handlers', () => {
  let permissionStub: sinon.SinonStub;

  beforeEach(() => {
    // Allow all permissions by default; individual tests override for denial
    permissionStub = sinon.stub(PermissionChecker.prototype, 'validateHas').returns(undefined);
  });

  afterEach(() => {
    sinon.restore();
  });

  // ── Suite 1: Create ─────────────────────────────────────────────────────

  describe('POST /tenant/:tenantId/global-inventory (create)', () => {
    it('creates an item and returns 200 with payload', async () => {
      const createStub = sinon.stub(InventoryItemService.prototype, 'create').resolves(SAMPLE_ITEM);
      const req = buildReq({ body: { name: 'Radio Motorola', type: 'radio' } });
      const res = buildRes();

      await createHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res._getData(), SAMPLE_ITEM);
      assert.ok(createStub.calledOnce);
      assert.deepStrictEqual(createStub.firstCall.args[0], { name: 'Radio Motorola', type: 'radio' });
    });

    it('uses req.body.data when present', async () => {
      const createStub = sinon.stub(InventoryItemService.prototype, 'create').resolves(SAMPLE_ITEM);
      const req = buildReq({ body: { data: { name: 'Chaleco', type: 'chaleco_antibalas' } } });
      const res = buildRes();

      await createHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(createStub.firstCall.args[0], { name: 'Chaleco', type: 'chaleco_antibalas' });
    });

    it('returns error when service throws', async () => {
      sinon.stub(InventoryItemService.prototype, 'create').rejects(new Error('DB failure'));
      const req = buildReq({ body: { name: 'Item', type: 'radio' } });
      const res = buildRes();

      await createHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });
  });

  // ── Suite 2: List ───────────────────────────────────────────────────────

  describe('GET /tenant/:tenantId/global-inventory (list)', () => {
    it('returns paginated list with 200', async () => {
      const listResult = { rows: [SAMPLE_ITEM], count: 1 };
      const listStub = sinon.stub(InventoryItemService.prototype, 'findAndCountAll').resolves(listResult);
      const req = buildReq({ query: { limit: '10', offset: '0' } });
      const res = buildRes();

      await listHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res._getData(), listResult);
      assert.ok(listStub.calledOnce);
      assert.deepStrictEqual(listStub.firstCall.args[0], { limit: '10', offset: '0' });
    });

    it('passes filter params to service', async () => {
      const listStub = sinon.stub(InventoryItemService.prototype, 'findAndCountAll').resolves({ rows: [], count: 0 });
      const query = { 'filter[type]': 'radio', 'filter[status]': 'disponible' };
      const req = buildReq({ query });
      const res = buildRes();

      await listHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(listStub.firstCall.args[0], query);
    });

    it('returns error when service throws', async () => {
      sinon.stub(InventoryItemService.prototype, 'findAndCountAll').rejects(new Error('Query failed'));
      const req = buildReq({ query: {} });
      const res = buildRes();

      await listHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });
  });

  // ── Suite 3: Find by ID ─────────────────────────────────────────────────

  describe('GET /tenant/:tenantId/global-inventory/:id (find)', () => {
    it('returns item by ID with 200', async () => {
      const findStub = sinon.stub(InventoryItemService.prototype, 'findById').resolves(SAMPLE_ITEM);
      const req = buildReq({ params: { tenantId: TENANT_ID, id: ITEM_ID } });
      const res = buildRes();

      await findHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res._getData(), SAMPLE_ITEM);
      assert.ok(findStub.calledOnce);
      assert.strictEqual(findStub.firstCall.args[0], ITEM_ID);
    });

    it('returns error when item not found', async () => {
      sinon.stub(InventoryItemService.prototype, 'findById').rejects(Object.assign(new Error('Not found'), { code: 404 }));
      const req = buildReq({ params: { tenantId: TENANT_ID, id: 'nonexistent' } });
      const res = buildRes();

      await findHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });
  });

  // ── Suite 4: Update ─────────────────────────────────────────────────────

  describe('PUT /tenant/:tenantId/global-inventory/:id (update)', () => {
    it('updates an item and returns 200', async () => {
      const updated = { ...SAMPLE_ITEM, name: 'Radio Kenwood' };
      const updateStub = sinon.stub(InventoryItemService.prototype, 'update').resolves(updated);
      const req = buildReq({
        params: { tenantId: TENANT_ID, id: ITEM_ID },
        body: { name: 'Radio Kenwood' },
      });
      const res = buildRes();

      await updateHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res._getData(), updated);
      assert.ok(updateStub.calledOnce);
      assert.strictEqual(updateStub.firstCall.args[0], ITEM_ID);
      assert.deepStrictEqual(updateStub.firstCall.args[1], { name: 'Radio Kenwood' });
    });

    it('uses req.body.data when present', async () => {
      const updated = { ...SAMPLE_ITEM, condition: 'dañado' };
      const updateStub = sinon.stub(InventoryItemService.prototype, 'update').resolves(updated);
      const req = buildReq({
        params: { tenantId: TENANT_ID, id: ITEM_ID },
        body: { data: { condition: 'dañado' } },
      });
      const res = buildRes();

      await updateHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(updateStub.firstCall.args[1], { condition: 'dañado' });
    });

    it('returns error when item not found', async () => {
      sinon.stub(InventoryItemService.prototype, 'update').rejects(Object.assign(new Error('Not found'), { code: 404 }));
      const req = buildReq({
        params: { tenantId: TENANT_ID, id: 'nonexistent' },
        body: { name: 'Test' },
      });
      const res = buildRes();

      await updateHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });
  });

  // ── Suite 5: Destroy ────────────────────────────────────────────────────

  describe('DELETE /tenant/:tenantId/global-inventory (destroy)', () => {
    it('deletes by body ids and returns 200', async () => {
      const destroyStub = sinon.stub(InventoryItemService.prototype, 'destroyAll').resolves(undefined);
      const successStub = sinon.stub(ApiResponseHandler, 'success').resolves(undefined);
      const req = buildReq({ body: { ids: [ITEM_ID, 'item-2'] } });
      const res = buildRes();

      await destroyHandler(req, res, () => {});

      assert.ok(destroyStub.calledOnce);
      assert.deepStrictEqual(destroyStub.firstCall.args[0], [ITEM_ID, 'item-2']);
      assert.ok(successStub.calledOnce);
      assert.strictEqual(successStub.firstCall.args[2], null);
    });

    it('deletes by single param id', async () => {
      const destroyStub = sinon.stub(InventoryItemService.prototype, 'destroyAll').resolves(undefined);
      const successStub = sinon.stub(ApiResponseHandler, 'success').resolves(undefined);
      const req = buildReq({
        params: { tenantId: TENANT_ID, id: ITEM_ID },
        body: {},
      });
      const res = buildRes();

      await destroyHandler(req, res, () => {});

      assert.ok(destroyStub.calledOnce);
      assert.deepStrictEqual(destroyStub.firstCall.args[0], [ITEM_ID]);
      assert.ok(successStub.calledOnce);
    });

    it('deletes by query ids', async () => {
      const destroyStub = sinon.stub(InventoryItemService.prototype, 'destroyAll').resolves(undefined);
      const successStub = sinon.stub(ApiResponseHandler, 'success').resolves(undefined);
      const req = buildReq({
        query: { ids: [ITEM_ID] },
        body: {},
      });
      const res = buildRes();

      await destroyHandler(req, res, () => {});

      assert.ok(destroyStub.calledOnce);
      assert.deepStrictEqual(destroyStub.firstCall.args[0], [ITEM_ID]);
      assert.ok(successStub.calledOnce);
    });

    it('returns error when service throws', async () => {
      sinon.stub(InventoryItemService.prototype, 'destroyAll').rejects(new Error('Deletion failed'));
      const req = buildReq({ body: { ids: ['bad-id'] } });
      const res = buildRes();

      await destroyHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });
  });

  // ── Suite 6: Autocomplete ───────────────────────────────────────────────

  describe('GET /tenant/:tenantId/global-inventory/autocomplete', () => {
    it('returns autocomplete results', async () => {
      const results = [{ id: ITEM_ID, label: 'Radio Motorola' }];
      const autoStub = sinon.stub(InventoryItemService.prototype, 'findAllAutocomplete').resolves(results);
      const req = buildReq({ query: { query: 'radio', limit: '10' } });
      const res = buildRes();

      await autocompleteHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res._getData(), results);
      assert.ok(autoStub.calledOnce);
      assert.strictEqual(autoStub.firstCall.args[0], 'radio');
      assert.strictEqual(autoStub.firstCall.args[1], '10');
    });

    it('returns empty array for no matches', async () => {
      sinon.stub(InventoryItemService.prototype, 'findAllAutocomplete').resolves([]);
      const req = buildReq({ query: { query: 'zzz', limit: '5' } });
      const res = buildRes();

      await autocompleteHandler(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res._getData(), []);
    });
  });

  // ── Suite 7: Permission denied ──────────────────────────────────────────

  describe('Permission denied scenarios', () => {
    beforeEach(() => {
      // Override the default stub to deny all
      permissionStub.restore();
      permissionStub = sinon.stub(PermissionChecker.prototype, 'validateHas').throws(
        new Error403('en'),
      );
    });

    it('create returns error on permission denied', async () => {
      const req = buildReq({ body: { name: 'Item', type: 'radio' } });
      const res = buildRes();

      await createHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });

    it('list returns error on permission denied', async () => {
      const req = buildReq({ query: {} });
      const res = buildRes();

      await listHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });

    it('find returns error on permission denied', async () => {
      const req = buildReq({ params: { tenantId: TENANT_ID, id: ITEM_ID } });
      const res = buildRes();

      await findHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });

    it('update returns error on permission denied', async () => {
      const req = buildReq({
        params: { tenantId: TENANT_ID, id: ITEM_ID },
        body: { name: 'Test' },
      });
      const res = buildRes();

      await updateHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });

    it('destroy returns error on permission denied', async () => {
      const req = buildReq({ body: { ids: [ITEM_ID] } });
      const res = buildRes();

      await destroyHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });

    it('autocomplete returns error on permission denied', async () => {
      const req = buildReq({ query: { query: 'radio' } });
      const res = buildRes();

      await autocompleteHandler(req, res, () => {});

      assert.ok(res.statusCode >= 400);
    });
  });
});
