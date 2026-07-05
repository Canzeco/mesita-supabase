-- place-images — the Storage bucket enricher-agent-store-place-images mirrors
-- gallery images into (bucket id hardcoded there as IMAGE_BUCKET since the
-- venue→place rename). The rename never created it: only the legacy
-- 'venue-images' bucket (0057) existed, so every mirror attempt since the
-- rename silently failed and place_media_assets rows strand at 'pending'.
-- Legacy objects stay in venue-images (their public URLs keep resolving);
-- new mirrors land here.

insert into storage.buckets (id, name, public)
values ('place-images', 'place-images', true)
on conflict (id) do nothing;
