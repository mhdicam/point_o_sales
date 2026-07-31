/**
 * Permission catalog — S2-01, design §12.
 *
 * Permissions are `domain.action` constants defined by the *system*, not by
 * tenants: the backend has to check exact names, so this list is the single
 * source of truth. Tenants compose them into roles (§12.1); they never invent
 * new permission keys.
 *
 * Adding an access rule means adding a key here, seeding it, and guarding the
 * endpoint — never `if (user.role === 'admin')` (design §12.4).
 */

export const PERMISSIONS = {
  // Orders — the POS floor
  ORDER_CREATE: 'order.create',
  ORDER_EDIT: 'order.edit',
  ORDER_SEND: 'order.send',
  ORDER_VOID: 'order.void',
  ORDER_ITEM_VOID: 'order.item.void',
  ORDER_TRANSFER: 'order.transfer',

  // Money-sensitive actions
  DISCOUNT_APPLY: 'discount.apply',
  PAYMENT_ACCEPT: 'payment.accept',
  PAYMENT_REFUND: 'payment.refund',

  // Shift / cash drawer
  SHIFT_OPEN: 'shift.open',
  SHIFT_CLOSE: 'shift.close',
  SHIFT_CASH_MOVEMENT: 'shift.cash_movement',

  // Master data
  PRODUCT_VIEW: 'product.view',
  PRODUCT_EDIT: 'product.edit',
  PRICE_EDIT: 'price.edit',

  // Inventory & purchasing
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_ADJUST: 'inventory.adjust',
  PURCHASE_CREATE: 'purchase.create',
  PURCHASE_APPROVE: 'purchase.approve',
  PURCHASE_RECEIVE: 'purchase.receive',
  SUPPLIER_MANAGE: 'supplier.manage',

  // Floor configuration
  TABLE_MANAGE: 'table.manage',
  RESERVATION_MANAGE: 'reservation.manage',

  // Reporting
  REPORT_VIEW: 'report.view',
  REPORT_EXPORT: 'report.export',
  REPORT_FINANCIAL_VIEW: 'report.financial.view',

  // Administration
  USER_MANAGE: 'user.manage',
  ROLE_MANAGE: 'role.manage',
  OUTLET_MANAGE: 'outlet.manage',
  SETTINGS_MANAGE: 'settings.manage',
  LANDING_MANAGE: 'landing.manage',
} as const

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as PermissionKey[]

export interface PermissionDefinition {
  key: PermissionKey
  domain: string
  description: string
}

/** Seeded into the `Permission` table; `description` surfaces in the role editor UI. */
export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  { key: PERMISSIONS.ORDER_CREATE, domain: 'order', description: 'Create a new order' },
  { key: PERMISSIONS.ORDER_EDIT, domain: 'order', description: 'Modify items on an open order' },
  { key: PERMISSIONS.ORDER_SEND, domain: 'order', description: 'Send an order to kitchen/station' },
  { key: PERMISSIONS.ORDER_VOID, domain: 'order', description: 'Void an entire order' },
  { key: PERMISSIONS.ORDER_ITEM_VOID, domain: 'order', description: 'Void a single order item' },
  {
    key: PERMISSIONS.ORDER_TRANSFER,
    domain: 'order',
    description: 'Transfer or merge orders between tables',
  },
  {
    key: PERMISSIONS.DISCOUNT_APPLY,
    domain: 'discount',
    description: 'Apply a discount to an item or order',
  },
  { key: PERMISSIONS.PAYMENT_ACCEPT, domain: 'payment', description: 'Accept payment for a bill' },
  { key: PERMISSIONS.PAYMENT_REFUND, domain: 'payment', description: 'Issue a refund' },
  { key: PERMISSIONS.SHIFT_OPEN, domain: 'shift', description: 'Open a shift with a cash float' },
  {
    key: PERMISSIONS.SHIFT_CLOSE,
    domain: 'shift',
    description: 'Close a shift and reconcile cash',
  },
  {
    key: PERMISSIONS.SHIFT_CASH_MOVEMENT,
    domain: 'shift',
    description: 'Record a cash in/out or safe drop',
  },
  { key: PERMISSIONS.PRODUCT_VIEW, domain: 'product', description: 'View the product catalog' },
  { key: PERMISSIONS.PRODUCT_EDIT, domain: 'product', description: 'Create or edit products' },
  { key: PERMISSIONS.PRICE_EDIT, domain: 'price', description: 'Edit prices and price lists' },
  { key: PERMISSIONS.INVENTORY_VIEW, domain: 'inventory', description: 'View stock levels' },
  {
    key: PERMISSIONS.INVENTORY_ADJUST,
    domain: 'inventory',
    description: 'Adjust stock (stock take, waste)',
  },
  {
    key: PERMISSIONS.PURCHASE_CREATE,
    domain: 'purchase',
    description: 'Create a purchase order',
  },
  {
    key: PERMISSIONS.PURCHASE_APPROVE,
    domain: 'purchase',
    description: 'Approve a purchase order',
  },
  {
    key: PERMISSIONS.PURCHASE_RECEIVE,
    domain: 'purchase',
    description: 'Receive goods against a purchase order',
  },
  { key: PERMISSIONS.SUPPLIER_MANAGE, domain: 'supplier', description: 'Manage suppliers' },
  { key: PERMISSIONS.TABLE_MANAGE, domain: 'table', description: 'Manage areas and tables' },
  {
    key: PERMISSIONS.RESERVATION_MANAGE,
    domain: 'reservation',
    description: 'Manage reservations',
  },
  { key: PERMISSIONS.REPORT_VIEW, domain: 'report', description: 'View operational reports' },
  { key: PERMISSIONS.REPORT_EXPORT, domain: 'report', description: 'Export reports to PDF/Excel' },
  {
    key: PERMISSIONS.REPORT_FINANCIAL_VIEW,
    domain: 'report',
    description: 'View financial reports (revenue, margin)',
  },
  { key: PERMISSIONS.USER_MANAGE, domain: 'user', description: 'Invite and manage users' },
  { key: PERMISSIONS.ROLE_MANAGE, domain: 'role', description: 'Create and edit roles' },
  { key: PERMISSIONS.OUTLET_MANAGE, domain: 'outlet', description: 'Manage outlets' },
  { key: PERMISSIONS.SETTINGS_MANAGE, domain: 'settings', description: 'Change tenant settings' },
  {
    key: PERMISSIONS.LANDING_MANAGE,
    domain: 'landing',
    description: 'Edit and publish the public landing page',
  },
]

/**
 * Preset roles — cloned per tenant at provisioning with `isSystem = true`
 * (design §12.2). A starting point, not a cage: tenants build custom roles freely.
 */
export const PRESET_ROLES: readonly { name: string; permissions: readonly PermissionKey[] }[] = [
  {
    name: 'Owner',
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'Manajer Outlet',
    permissions: [
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.ORDER_EDIT,
      PERMISSIONS.ORDER_SEND,
      PERMISSIONS.ORDER_VOID,
      PERMISSIONS.ORDER_ITEM_VOID,
      PERMISSIONS.ORDER_TRANSFER,
      PERMISSIONS.DISCOUNT_APPLY,
      PERMISSIONS.PAYMENT_ACCEPT,
      PERMISSIONS.PAYMENT_REFUND,
      PERMISSIONS.SHIFT_OPEN,
      PERMISSIONS.SHIFT_CLOSE,
      PERMISSIONS.SHIFT_CASH_MOVEMENT,
      PERMISSIONS.PRODUCT_VIEW,
      PERMISSIONS.PRODUCT_EDIT,
      PERMISSIONS.PRICE_EDIT,
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.INVENTORY_ADJUST,
      PERMISSIONS.PURCHASE_CREATE,
      PERMISSIONS.PURCHASE_APPROVE,
      PERMISSIONS.PURCHASE_RECEIVE,
      PERMISSIONS.SUPPLIER_MANAGE,
      PERMISSIONS.TABLE_MANAGE,
      PERMISSIONS.RESERVATION_MANAGE,
      PERMISSIONS.REPORT_VIEW,
      PERMISSIONS.REPORT_EXPORT,
      PERMISSIONS.REPORT_FINANCIAL_VIEW,
      PERMISSIONS.USER_MANAGE,
    ],
  },
  {
    name: 'Supervisor Shift',
    permissions: [
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.ORDER_EDIT,
      PERMISSIONS.ORDER_SEND,
      PERMISSIONS.ORDER_VOID,
      PERMISSIONS.ORDER_ITEM_VOID,
      PERMISSIONS.ORDER_TRANSFER,
      PERMISSIONS.DISCOUNT_APPLY,
      PERMISSIONS.PAYMENT_ACCEPT,
      PERMISSIONS.SHIFT_OPEN,
      PERMISSIONS.SHIFT_CLOSE,
      PERMISSIONS.SHIFT_CASH_MOVEMENT,
      PERMISSIONS.PRODUCT_VIEW,
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.TABLE_MANAGE,
      PERMISSIONS.RESERVATION_MANAGE,
      PERMISSIONS.REPORT_VIEW,
    ],
  },
  {
    name: 'Kasir',
    permissions: [
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.ORDER_EDIT,
      PERMISSIONS.ORDER_SEND,
      PERMISSIONS.PAYMENT_ACCEPT,
      PERMISSIONS.SHIFT_OPEN,
      PERMISSIONS.SHIFT_CLOSE,
      PERMISSIONS.PRODUCT_VIEW,
    ],
  },
  {
    name: 'Dapur',
    permissions: [PERMISSIONS.PRODUCT_VIEW],
  },
]
