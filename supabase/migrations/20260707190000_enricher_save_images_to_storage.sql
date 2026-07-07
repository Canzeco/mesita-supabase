-- Enricher: gate S9 image→Storage mirroring behind an admin binary.
--
-- The admin Enricher Config "Images" box now carries a single on/off for
-- persisting the selected gallery into Supabase Storage. Defaults TRUE so the
-- existing behavior (S9 mirrors the picked photos) is unchanged; flipping it
-- off makes the pipeline leave photos rendering from their source URLs only.
alter table public.app_settings
  add column if not exists atlas_save_images_to_storage boolean not null default true;

-- The console no longer exposes a "computer vision" toggle — image analysis
-- always runs. The column stays (the pipeline still reads cfg.visionEnabled),
-- so pin row 1 ON to match the new always-on contract.
update public.app_settings set atlas_image_vision_enabled = true where id = 1;
