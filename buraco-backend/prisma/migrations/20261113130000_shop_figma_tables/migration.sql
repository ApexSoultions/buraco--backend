-- The old placeholder tables are not in Figma (Maroon / Green / Blue come from the content
-- seed). Hide them from the shop; players who bought one keep it in their inventory.
UPDATE "shop_items" SET "isActive" = false
WHERE "category" = 'TABLES' AND "name" IN ('Classic Green Table', 'Marble Table', 'Beach Table');
