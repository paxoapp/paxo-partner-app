-- Adds the "spirits" choice type (e.g. "choose any 2 spirits" across vodka, gin and rum). Widens two check constraints only.
alter table public.menu_categories drop constraint menu_categories_kind_check;
alter table public.menu_categories add constraint menu_categories_kind_check check (kind = any (array[
  'starter_veg','starter_non_veg','main_veg','main_non_veg','dessert','wine','beer','whisky','single_malt','vodka','rum','gin',
  'spirits','classic_cocktails','mocktails','soft_beverages','side','other']));

alter table public.menu_quota_rules drop constraint menu_quota_rules_category_kind_check;
alter table public.menu_quota_rules add constraint menu_quota_rules_category_kind_check check (category_kind = any (array[
  'starter_veg','starter_non_veg','main_veg','main_non_veg','dessert','wine','beer','whisky','single_malt','vodka','rum','gin',
  'spirits','classic_cocktails','mocktails','soft_beverages','side','other']));
