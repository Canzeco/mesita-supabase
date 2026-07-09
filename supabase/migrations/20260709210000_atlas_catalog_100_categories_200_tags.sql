-- Atlas Taxonomy v2 — reconcile the live catalog to exactly 100 categories + 200
-- tags (MESITA-364). Pato approved the Notion Atlas page and directed: "100
-- categories, 200 tags, consistent in admin console and Supabase — you decide."
--
-- Decisions (agent-owned):
--  * snake_case, not the page's kebab-case. The live DB, _shared/tags.ts exclusive
--    groups and all three web pickers use snake_case; "graft new" = additive, so
--    the existing 100 tags are kept verbatim and 100 net-new are grafted.
--  * Facets unchanged (the existing 17). Every one of the 200 tags maps into an
--    existing facet, so TAG_FACETS and every Edge Function are untouched: admin,
--    business, consumer and the Enricher all read the catalog live via
--    fetchPlaceTags / fetchPlaceCategories, so this reseed alone keeps them
--    consistent — no EF or frontend redeploy.
--  * Categories: 3 swaps only (97 unchanged). OUT buffet/healthy/virtual_golf,
--    IN food_hall/park/market. healthy + buffet survive as tags.
--
-- Both seed helpers are rewritten in full so admin_reset_database() rebuilds the
-- identical catalog, then called; removed slugs are deleted (seed upserts, it
-- never removes); the sole drift row (locally_owned) is scrubbed.

-- ---------------------------------------------------------------------------
-- 1. Categories — 100 (3 swaps). Rebuild the seed helper, then prune removed.
-- ---------------------------------------------------------------------------
create or replace function public.seed_place_categories()
returns void
language sql
set search_path = ''
as $function$
  insert into public.place_categories (slug, label, section, sort_order) values
    ('mexican', '🌮 Mexican', 'Food & Nightlife', 1),
    ('taco', '🌮 Tacos', 'Food & Nightlife', 2),
    ('seafood', '🦐 Seafood', 'Food & Nightlife', 3),
    ('steak_house', '🥩 Steakhouse', 'Food & Nightlife', 4),
    ('italian', '🍝 Italian', 'Food & Nightlife', 5),
    ('pizza', '🍕 Pizza', 'Food & Nightlife', 6),
    ('japanese', '🍱 Japanese', 'Food & Nightlife', 7),
    ('sushi', '🍣 Sushi', 'Food & Nightlife', 8),
    ('ramen', '🍜 Ramen', 'Food & Nightlife', 9),
    ('chinese', '🥡 Chinese', 'Food & Nightlife', 10),
    ('thai', '🌶️ Thai', 'Food & Nightlife', 11),
    ('korean', '🍲 Korean', 'Food & Nightlife', 12),
    ('vietnamese', '🍜 Vietnamese', 'Food & Nightlife', 13),
    ('indian', '🍛 Indian', 'Food & Nightlife', 14),
    ('middle_eastern', '🧆 Middle Eastern', 'Food & Nightlife', 15),
    ('mediterranean', '🫒 Mediterranean', 'Food & Nightlife', 16),
    ('greek', '🥙 Greek', 'Food & Nightlife', 17),
    ('spanish', '🥘 Spanish', 'Food & Nightlife', 18),
    ('french', '🥐 French', 'Food & Nightlife', 19),
    ('american', '🍟 American', 'Food & Nightlife', 20),
    ('argentinian', '🥩 Argentinian', 'Food & Nightlife', 21),
    ('brazilian', '🍖 Brazilian', 'Food & Nightlife', 22),
    ('peruvian', '🐟 Peruvian', 'Food & Nightlife', 23),
    ('asian_fusion', '🥢 Asian Fusion', 'Food & Nightlife', 24),
    ('burger', '🍔 Burgers', 'Food & Nightlife', 25),
    ('sandwich', '🥪 Sandwiches', 'Food & Nightlife', 26),
    ('bbq', '🍖 BBQ', 'Food & Nightlife', 27),
    ('breakfast', '🍳 Breakfast', 'Food & Nightlife', 28),
    ('brunch', '🥞 Brunch', 'Food & Nightlife', 29),
    ('vegan', '🌱 Vegan', 'Food & Nightlife', 30),
    ('vegetarian', '🥬 Vegetarian', 'Food & Nightlife', 31),
    ('salad', '🥗 Salads', 'Food & Nightlife', 33),
    ('fast_food', '🍟 Fast Food', 'Food & Nightlife', 34),
    ('fine_dining', '🍽️ Fine Dining', 'Food & Nightlife', 35),
    ('food_truck', '🚚 Food Truck', 'Food & Nightlife', 36),
    ('food_hall', '🍜 Food Hall', 'Food & Nightlife', 37),
    ('deli', '🥓 Deli', 'Food & Nightlife', 38),
    ('cafe', '☕ Café', 'Food & Nightlife', 39),
    ('coffee_shop', '☕ Coffee Shop', 'Food & Nightlife', 40),
    ('bakery', '🥐 Bakery', 'Food & Nightlife', 41),
    ('dessert_shop', '🍰 Desserts', 'Food & Nightlife', 42),
    ('ice_cream', '🍦 Ice Cream', 'Food & Nightlife', 43),
    ('juice_bar', '🧃 Juice Bar', 'Food & Nightlife', 44),
    ('bar', '🍺 Bar', 'Food & Nightlife', 45),
    ('pub', '🍺 Pub', 'Food & Nightlife', 46),
    ('cocktail_bar', '🍸 Cocktail Bar', 'Food & Nightlife', 47),
    ('wine_bar', '🍷 Wine Bar', 'Food & Nightlife', 48),
    ('brewery', '🍻 Brewery', 'Food & Nightlife', 49),
    ('night_club', '🪩 Nightclub', 'Food & Nightlife', 50),
    ('bowling_alley', '🎳 Bowling', 'Experiences & Wellness', 51),
    ('karaoke', '🎤 Karaoke', 'Experiences & Wellness', 52),
    ('escape_room', '🗝️ Escape Room', 'Experiences & Wellness', 53),
    ('arcade', '🕹️ Arcade', 'Experiences & Wellness', 54),
    ('billiards', '🎱 Billiards', 'Experiences & Wellness', 55),
    ('board_game_cafe', '🎲 Board Game Café', 'Experiences & Wellness', 56),
    ('park', '🌳 Park', 'Experiences & Wellness', 57),
    ('mini_golf', '⛳ Mini Golf', 'Experiences & Wellness', 58),
    ('laser_tag', '🔫 Laser Tag', 'Experiences & Wellness', 59),
    ('axe_throwing', '🪓 Axe Throwing', 'Experiences & Wellness', 60),
    ('trampoline_park', '🤸 Trampoline Park', 'Experiences & Wellness', 61),
    ('go_kart', '🏎️ Go-Karts', 'Experiences & Wellness', 62),
    ('movie_theater', '🎬 Movie Theater', 'Experiences & Wellness', 63),
    ('amusement_park', '🎡 Amusement Park', 'Experiences & Wellness', 64),
    ('water_park', '🌊 Water Park', 'Experiences & Wellness', 65),
    ('casino', '🎰 Casino', 'Experiences & Wellness', 66),
    ('gym', '💪 Gym', 'Experiences & Wellness', 67),
    ('yoga_studio', '🧘 Yoga Studio', 'Experiences & Wellness', 68),
    ('pilates_studio', '🧘 Pilates Studio', 'Experiences & Wellness', 69),
    ('crossfit_box', '🏋️ CrossFit', 'Experiences & Wellness', 70),
    ('climbing_gym', '🧗 Climbing Gym', 'Experiences & Wellness', 71),
    ('padel_club', '🎾 Padel Club', 'Experiences & Wellness', 72),
    ('tennis_club', '🎾 Tennis Club', 'Experiences & Wellness', 73),
    ('golf_course', '⛳ Golf Course', 'Experiences & Wellness', 74),
    ('soccer_field', '⚽ Soccer Field', 'Experiences & Wellness', 75),
    ('swimming_pool', '🏊 Swimming Pool', 'Experiences & Wellness', 76),
    ('dance_studio', '💃 Dance Studio', 'Experiences & Wellness', 77),
    ('martial_arts', '🥋 Martial Arts', 'Experiences & Wellness', 78),
    ('spa', '💆 Spa', 'Experiences & Wellness', 79),
    ('temazcal', '🔥 Temazcal', 'Experiences & Wellness', 80),
    ('hot_springs', '♨️ Hot Springs', 'Experiences & Wellness', 81),
    ('massage', '💆 Massage', 'Experiences & Wellness', 82),
    ('sauna', '🧖 Sauna', 'Experiences & Wellness', 83),
    ('barbershop', '💈 Barbershop', 'Experiences & Wellness', 84),
    ('hair_salon', '💇 Hair Salon', 'Experiences & Wellness', 85),
    ('nail_salon', '💅 Nail Salon', 'Experiences & Wellness', 86),
    ('beauty_salon', '💄 Beauty Salon', 'Experiences & Wellness', 87),
    ('wellness_center', '🌿 Wellness Center', 'Experiences & Wellness', 88),
    ('tattoo_studio', '🖋️ Tattoo Studio', 'Experiences & Wellness', 89),
    ('medical_spa', '💉 Medical Spa', 'Experiences & Wellness', 90),
    ('museum', '🏛️ Museum', 'Experiences & Wellness', 91),
    ('art_gallery', '🖼️ Art Gallery', 'Experiences & Wellness', 92),
    ('aquarium', '🐠 Aquarium', 'Experiences & Wellness', 93),
    ('zoo', '🦁 Zoo', 'Experiences & Wellness', 94),
    ('observation_deck', '🌆 Observation Deck', 'Experiences & Wellness', 95),
    ('winery', '🍷 Winery', 'Experiences & Wellness', 96),
    ('theater', '🎭 Theater', 'Experiences & Wellness', 97),
    ('concert_venue', '🎸 Concert Venue', 'Experiences & Wellness', 98),
    ('botanical_garden', '🌷 Botanical Garden', 'Experiences & Wellness', 99),
    ('cultural_center', '🎟️ Cultural Center', 'Experiences & Wellness', 100),
    ('market', '🛒 Market', 'Experiences & Wellness', 101)
  on conflict (slug) do update set
    label      = excluded.label,
    section    = excluded.section,
    sort_order = excluded.sort_order;
$function$;

-- Re-home any place on a removed category (0 today) before deleting them.
update public.places
   set category = 'undefined',
       category_label = (select label from public.place_categories where slug = 'undefined')
 where category in ('buffet', 'healthy', 'virtual_golf');

select public.seed_place_categories();

delete from public.place_categories where slug in ('buffet', 'healthy', 'virtual_golf');

-- ---------------------------------------------------------------------------
-- 2. Tags — 200 (100 existing kept + 100 grafted). Rebuild seed, then prune.
-- ---------------------------------------------------------------------------
create or replace function public.seed_place_tags()
returns void
language sql
set search_path = ''
as $function$
  insert into public.place_tags (slug, label_es, label_en, facet, section, sort_order) values
    -- payment (Both)
    ('cash', 'Efectivo', 'Cash', 'payment', 'Both', 1),
    ('cards', 'Tarjetas', 'Credit & debit cards', 'payment', 'Both', 2),
    ('contactless', 'Pago sin contacto', 'Contactless / NFC', 'payment', 'Both', 3),
    ('cash_only', 'Solo efectivo', 'Cash only', 'payment', 'Both', 4),
    ('meal_vouchers', 'Vales de despensa', 'Meal vouchers', 'payment', 'Both', 5),
    ('amex', 'Acepta AMEX', 'AMEX accepted', 'payment', 'Both', 6),
    ('mobile_payments', 'Pagos móviles', 'Mobile payments', 'payment', 'Both', 7),
    -- booking (Both)
    ('accepts_reservations', 'Acepta reservaciones', 'Accepts reservations', 'booking', 'Both', 8),
    ('reservations_required', 'Reservación obligatoria', 'Reservations required', 'booking', 'Both', 9),
    ('walk_ins_welcome', 'Sin reservación', 'Walk-ins welcome', 'booking', 'Both', 10),
    ('online_booking', 'Reserva en línea', 'Online booking', 'booking', 'Both', 11),
    ('usually_a_wait', 'Suele haber fila', 'Usually a wait', 'booking', 'Both', 12),
    ('group_reservations', 'Grupos grandes', 'Large group bookings', 'booking', 'Both', 13),
    ('private_events', 'Eventos privados', 'Private events', 'booking', 'Both', 14),
    -- service (Food & Nightlife)
    ('dine_in', 'Para comer aquí', 'Dine-in', 'service', 'Food & Nightlife', 15),
    ('takeout', 'Para llevar', 'Takeout', 'service', 'Food & Nightlife', 16),
    ('delivery', 'A domicilio', 'Delivery', 'service', 'Food & Nightlife', 17),
    ('drive_through', 'Drive-thru', 'Drive-through', 'service', 'Food & Nightlife', 18),
    ('catering', 'Catering', 'Catering', 'service', 'Food & Nightlife', 19),
    ('curbside_pickup', 'Recoger en auto', 'Curbside pickup', 'service', 'Food & Nightlife', 20),
    ('counter_service', 'Ordena en barra', 'Counter service', 'service', 'Food & Nightlife', 21),
    ('byob', 'Descorche', 'BYOB / corkage', 'service', 'Food & Nightlife', 22),
    -- vibe (Both)
    ('casual', 'Casual', 'Casual', 'vibe', 'Both', 23),
    ('upscale', 'Sofisticado', 'Upscale', 'vibe', 'Both', 24),
    ('romantic', 'Romántico', 'Romantic', 'vibe', 'Both', 25),
    ('cozy', 'Acogedor', 'Cozy', 'vibe', 'Both', 26),
    ('trendy', 'De moda', 'Trendy', 'vibe', 'Both', 27),
    ('lively', 'Animado', 'Lively', 'vibe', 'Both', 28),
    ('quiet', 'Tranquilo', 'Quiet', 'vibe', 'Both', 29),
    ('instagrammable', 'Instagrameable', 'Instagrammable', 'vibe', 'Both', 30),
    ('classic', 'Clásico', 'Classic', 'vibe', 'Both', 31),
    ('intimate', 'Íntimo', 'Intimate', 'vibe', 'Both', 32),
    ('artsy', 'Artístico', 'Artsy', 'vibe', 'Both', 33),
    ('historic', 'Histórico', 'Historic', 'vibe', 'Both', 34),
    ('modern', 'Moderno', 'Modern', 'vibe', 'Both', 35),
    ('rustic', 'Rústico', 'Rustic', 'vibe', 'Both', 36),
    ('bohemian', 'Bohemio', 'Bohemian', 'vibe', 'Both', 37),
    ('luxurious', 'Lujoso', 'Luxurious', 'vibe', 'Both', 38),
    ('minimalist', 'Minimalista', 'Minimalist', 'vibe', 'Both', 39),
    ('iconic', 'Icónico', 'Iconic', 'vibe', 'Both', 40),
    ('themed', 'Temático', 'Themed', 'vibe', 'Both', 41),
    ('festive', 'Festivo', 'Festive', 'vibe', 'Both', 42),
    -- occasion (Both)
    ('date_night', 'Cita romántica', 'Date night', 'occasion', 'Both', 43),
    ('groups', 'Grupos grandes', 'Good for groups', 'occasion', 'Both', 44),
    ('families', 'Familias', 'Families', 'occasion', 'Both', 45),
    ('business_meals', 'Comidas de negocios', 'Business meals', 'occasion', 'Both', 46),
    ('special_occasions', 'Ocasiones especiales', 'Special occasions', 'occasion', 'Both', 47),
    ('working_laptop', 'Trabajar con laptop', 'Good for working', 'occasion', 'Both', 48),
    ('solo', 'Para ir solo', 'Solo friendly', 'occasion', 'Both', 49),
    ('birthdays', 'Cumpleaños', 'Birthdays', 'occasion', 'Both', 50),
    ('celebrations', 'Celebraciones', 'Celebrations', 'occasion', 'Both', 51),
    ('girls_night', 'Noche de chicas', 'Girls'' night', 'occasion', 'Both', 52),
    ('after_work', 'After office', 'After work', 'occasion', 'Both', 53),
    ('first_dates', 'Primeras citas', 'First dates', 'occasion', 'Both', 54),
    ('studying', 'Para estudiar', 'Good for studying', 'occasion', 'Both', 55),
    ('watching_sports', 'Ver deportes', 'Watching sports', 'occasion', 'Both', 56),
    ('late_night_out', 'Noche larga', 'Late night out', 'occasion', 'Both', 57),
    -- amenities (Both)
    ('wifi', 'Wi-Fi', 'Wi-Fi', 'amenities', 'Both', 58),
    ('air_conditioning', 'Aire acondicionado', 'Air conditioning', 'amenities', 'Both', 59),
    ('outdoor_seating', 'Mesas al aire libre', 'Outdoor seating', 'amenities', 'Both', 60),
    ('rooftop', 'Terraza / Rooftop', 'Rooftop', 'amenities', 'Both', 61),
    ('private_room', 'Salón privado', 'Private room', 'amenities', 'Both', 62),
    ('terrace', 'Terraza', 'Terrace', 'amenities', 'Both', 63),
    ('garden', 'Jardín', 'Garden', 'amenities', 'Both', 64),
    ('indoor_dining', 'Salón interior', 'Indoor dining room', 'amenities', 'Both', 65),
    ('bar_seating', 'Barra', 'Bar seating', 'amenities', 'Both', 66),
    ('booths', 'Gabinetes', 'Booths', 'amenities', 'Both', 67),
    ('communal_tables', 'Mesas compartidas', 'Communal tables', 'amenities', 'Both', 68),
    ('chefs_table', 'Mesa del chef', 'Chef''s table', 'amenities', 'Both', 69),
    ('lounge', 'Lounge', 'Lounge area', 'amenities', 'Both', 70),
    ('fireplace', 'Chimenea', 'Fireplace', 'amenities', 'Both', 71),
    ('power_outlets', 'Enchufes', 'Power outlets', 'amenities', 'Both', 72),
    ('parking', 'Estacionamiento', 'Parking', 'amenities', 'Both', 73),
    ('valet', 'Valet parking', 'Valet parking', 'amenities', 'Both', 74),
    ('free_parking', 'Estacionamiento gratis', 'Free parking', 'amenities', 'Both', 75),
    ('paid_parking', 'Estacionamiento de paga', 'Paid parking', 'amenities', 'Both', 76),
    ('street_parking', 'Estacionamiento en calle', 'Street parking', 'amenities', 'Both', 77),
    ('parking_lot', 'Estacionamiento propio', 'Own parking lot', 'amenities', 'Both', 78),
    ('bike_parking', 'Biciestacionamiento', 'Bike parking', 'amenities', 'Both', 79),
    ('near_transit', 'Cerca del transporte', 'Near public transit', 'amenities', 'Both', 80),
    ('ev_charging', 'Cargador eléctrico', 'EV charging', 'amenities', 'Both', 81),
    ('walkable_area', 'Zona caminable', 'Walkable area', 'amenities', 'Both', 82),
    ('central_location', 'Ubicación céntrica', 'Central location', 'amenities', 'Both', 83),
    ('wheelchair_accessible', 'Accesible silla de ruedas', 'Wheelchair accessible', 'amenities', 'Both', 84),
    ('wheelchair_entrance', 'Entrada accesible', 'Accessible entrance', 'amenities', 'Both', 85),
    ('wheelchair_restroom', 'Baño accesible', 'Accessible restroom', 'amenities', 'Both', 86),
    ('accessible_parking', 'Estacionamiento accesible', 'Accessible parking', 'amenities', 'Both', 87),
    ('elevator', 'Elevador', 'Elevator', 'amenities', 'Both', 88),
    ('high_chairs', 'Periqueras', 'High chairs', 'amenities', 'Both', 89),
    ('changing_tables', 'Cambiadores', 'Changing tables', 'amenities', 'Both', 90),
    ('stroller_friendly', 'Apto para carriolas', 'Stroller friendly', 'amenities', 'Both', 91),
    ('restrooms', 'Baños', 'Public restrooms', 'amenities', 'Both', 92),
    ('service_animals', 'Animales de servicio', 'Service animals welcome', 'amenities', 'Both', 93),
    -- dietary (Food & Nightlife)
    ('vegetarian', 'Vegetariano', 'Vegetarian options', 'dietary', 'Food & Nightlife', 94),
    ('vegan', 'Vegano', 'Vegan options', 'dietary', 'Food & Nightlife', 95),
    ('gluten_free', 'Sin gluten', 'Gluten-free options', 'dietary', 'Food & Nightlife', 96),
    ('healthy', 'Saludable', 'Healthy options', 'dietary', 'Food & Nightlife', 97),
    ('organic', 'Orgánico', 'Organic', 'dietary', 'Food & Nightlife', 98),
    ('keto', 'Keto', 'Keto-friendly', 'dietary', 'Food & Nightlife', 99),
    ('dairy_free', 'Sin lácteos', 'Dairy-free options', 'dietary', 'Food & Nightlife', 100),
    ('sugar_free', 'Sin azúcar', 'Sugar-free options', 'dietary', 'Food & Nightlife', 101),
    ('halal', 'Halal', 'Halal', 'dietary', 'Food & Nightlife', 102),
    ('kosher', 'Kosher', 'Kosher', 'dietary', 'Food & Nightlife', 103),
    ('low_carb', 'Bajo en carbos', 'Low carb', 'dietary', 'Food & Nightlife', 104),
    ('allergy_aware', 'Apto para alergias', 'Allergy aware', 'dietary', 'Food & Nightlife', 105),
    -- menu (Food & Nightlife)
    ('breakfast', 'Desayuno', 'Breakfast', 'menu', 'Food & Nightlife', 106),
    ('brunch', 'Brunch', 'Brunch', 'menu', 'Food & Nightlife', 107),
    ('dinner', 'Cena', 'Dinner', 'menu', 'Food & Nightlife', 108),
    ('coffee', 'Café', 'Coffee', 'menu', 'Food & Nightlife', 109),
    ('dessert', 'Postres', 'Dessert', 'menu', 'Food & Nightlife', 110),
    ('kids_menu', 'Menú infantil', 'Kids'' menu', 'menu', 'Food & Nightlife', 111),
    ('street_food', 'Comida callejera', 'Street food', 'menu', 'Food & Nightlife', 112),
    ('lunch', 'Comidas', 'Lunch', 'menu', 'Food & Nightlife', 113),
    ('tea_selection', 'Té e infusiones', 'Tea selection', 'menu', 'Food & Nightlife', 114),
    ('fresh_juices', 'Jugos naturales', 'Fresh juices', 'menu', 'Food & Nightlife', 115),
    ('smoothies', 'Smoothies', 'Smoothies', 'menu', 'Food & Nightlife', 116),
    ('tasting_menu', 'Menú degustación', 'Tasting menu', 'menu', 'Food & Nightlife', 117),
    ('buffet', 'Buffet', 'Buffet', 'menu', 'Food & Nightlife', 118),
    ('farm_to_table', 'De la granja a la mesa', 'Farm to table', 'menu', 'Food & Nightlife', 119),
    ('wood_fired', 'Horno de leña', 'Wood-fired', 'menu', 'Food & Nightlife', 120),
    -- drinks (Food & Nightlife)
    ('full_bar', 'Bar completo', 'Full bar', 'drinks', 'Food & Nightlife', 121),
    ('cocktails', 'Coctelería', 'Cocktails', 'drinks', 'Food & Nightlife', 122),
    ('craft_beer', 'Cerveza artesanal', 'Craft beer', 'drinks', 'Food & Nightlife', 123),
    ('wine_list', 'Carta de vinos', 'Wine list', 'drinks', 'Food & Nightlife', 124),
    ('mezcal_tequila', 'Mezcal y tequila', 'Mezcal & tequila', 'drinks', 'Food & Nightlife', 125),
    ('happy_hour', 'Happy hour', 'Happy hour', 'drinks', 'Food & Nightlife', 126),
    ('non_alcoholic', 'Sin alcohol', 'Non-alcoholic options', 'drinks', 'Food & Nightlife', 127),
    ('beer', 'Cerveza', 'Serves beer', 'drinks', 'Food & Nightlife', 128),
    ('craft_cocktails', 'Coctelería de autor', 'Craft cocktails', 'drinks', 'Food & Nightlife', 129),
    ('natural_wine', 'Vino natural', 'Natural wine', 'drinks', 'Food & Nightlife', 130),
    -- entertainment (Both)
    ('live_music', 'Música en vivo', 'Live music', 'entertainment', 'Both', 131),
    ('dj', 'DJ', 'DJ', 'entertainment', 'Both', 132),
    ('karaoke', 'Karaoke', 'Karaoke', 'entertainment', 'Both', 133),
    ('dancing', 'Pista de baile', 'Dancing', 'entertainment', 'Both', 134),
    ('sports_screening', 'Transmite deportes', 'Sports on TV', 'entertainment', 'Both', 135),
    ('board_games', 'Juegos de mesa', 'Board games', 'entertainment', 'Both', 136),
    ('trivia', 'Trivia', 'Trivia nights', 'entertainment', 'Both', 137),
    ('comedy', 'Comedia', 'Comedy nights', 'entertainment', 'Both', 138),
    ('live_shows', 'Shows en vivo', 'Live shows', 'entertainment', 'Both', 139),
    ('mariachi', 'Mariachi y regional', 'Mariachi & regional', 'entertainment', 'Both', 140),
    ('jazz', 'Jazz', 'Jazz nights', 'entertainment', 'Both', 141),
    ('open_mic', 'Micrófono abierto', 'Open mic', 'entertainment', 'Both', 142),
    ('billiards_tables', 'Billar', 'Billiards', 'entertainment', 'Both', 143),
    ('arcade_games', 'Arcade', 'Arcade games', 'entertainment', 'Both', 144),
    ('art_exhibitions', 'Expos de arte', 'Art exhibitions', 'entertainment', 'Both', 145),
    ('themed_nights', 'Noches temáticas', 'Themed nights', 'entertainment', 'Both', 146),
    ('wine_tastings', 'Catas', 'Tastings', 'entertainment', 'Both', 147),
    -- crowd (Both)
    ('family_friendly', 'Para toda la familia', 'Family-friendly', 'crowd', 'Both', 148),
    ('lgbtq_friendly', 'LGBTQ+ friendly', 'LGBTQ+ friendly', 'crowd', 'Both', 149),
    ('pet_friendly', 'Pet friendly', 'Pet-friendly', 'crowd', 'Both', 150),
    ('local_favorite', 'Favorito local', 'Local favorite', 'crowd', 'Both', 151),
    ('tourist_favorite', 'Favorito de turistas', 'Tourist favorite', 'crowd', 'Both', 152),
    ('adults_only', 'Solo adultos', 'Adults only', 'crowd', 'Both', 153),
    ('senior_friendly', 'Adultos mayores bienvenidos', 'Senior friendly', 'crowd', 'Both', 154),
    -- setting (Both)
    ('scenic_view', 'Con vista', 'Scenic view', 'setting', 'Both', 155),
    ('beachfront', 'En la playa', 'Beachfront', 'setting', 'Both', 156),
    ('downtown', 'En el centro', 'Downtown', 'setting', 'Both', 157),
    ('mall_location', 'En plaza comercial', 'Inside a mall', 'setting', 'Both', 158),
    ('hidden_gem', 'Joya escondida', 'Hidden gem', 'setting', 'Both', 159),
    ('city_view', 'Vista a la ciudad', 'City view', 'setting', 'Both', 160),
    ('sunset_spot', 'Atardeceres', 'Sunset spot', 'setting', 'Both', 161),
    ('waterfront', 'Frente al agua', 'Waterfront', 'setting', 'Both', 162),
    -- hours (Both)
    ('open_late', 'Abierto hasta tarde', 'Open late', 'hours', 'Both', 163),
    ('open_24h', 'Abierto 24 horas', 'Open 24 hours', 'hours', 'Both', 164),
    ('open_early', 'Abre temprano', 'Opens early', 'hours', 'Both', 165),
    ('seasonal', 'De temporada', 'Seasonal', 'hours', 'Both', 166),
    -- dress (Food & Nightlife)
    ('casual_dress', 'Vestimenta casual', 'Casual', 'dress', 'Food & Nightlife', 167),
    ('smart_casual', 'Smart casual', 'Smart casual', 'dress', 'Food & Nightlife', 168),
    ('formal_dress', 'Formal / Etiqueta', 'Formal', 'dress', 'Food & Nightlife', 169),
    -- wellness (Experiences & Wellness)
    ('unisex', 'Unisex', 'Unisex', 'wellness', 'Experiences & Wellness', 170),
    ('lockers', 'Lockers', 'Lockers', 'wellness', 'Experiences & Wellness', 171),
    ('showers', 'Regaderas', 'Showers', 'wellness', 'Experiences & Wellness', 172),
    ('sauna', 'Sauna', 'Sauna', 'wellness', 'Experiences & Wellness', 173),
    ('jacuzzi', 'Jacuzzi', 'Jacuzzi', 'wellness', 'Experiences & Wellness', 174),
    ('pool', 'Alberca', 'Pool', 'wellness', 'Experiences & Wellness', 175),
    ('private_cabins', 'Cabinas privadas', 'Private cabins', 'wellness', 'Experiences & Wellness', 176),
    ('couples_treatment', 'Tratamiento en pareja', 'Couples treatment', 'wellness', 'Experiences & Wellness', 177),
    ('day_pass', 'Pase del día', 'Day pass', 'wellness', 'Experiences & Wellness', 178),
    ('memberships', 'Membresías', 'Memberships', 'wellness', 'Experiences & Wellness', 179),
    -- experiences (Experiences & Wellness)
    ('guided', 'Con guía', 'Guided', 'experiences', 'Experiences & Wellness', 180),
    ('equipment_provided', 'Equipo incluido', 'Equipment provided', 'experiences', 'Experiences & Wellness', 181),
    ('beginner_friendly', 'Para principiantes', 'Beginner-friendly', 'experiences', 'Experiences & Wellness', 182),
    ('all_ages', 'Para todas las edades', 'All ages', 'experiences', 'Experiences & Wellness', 183),
    ('kids_activity', 'Actividad infantil', 'Kids'' activity', 'experiences', 'Experiences & Wellness', 184),
    ('team_building', 'Team building', 'Team building', 'experiences', 'Experiences & Wellness', 185),
    ('transport_included', 'Transporte incluido', 'Transport included', 'experiences', 'Experiences & Wellness', 186),
    ('english_spoken', 'Inglés disponible', 'English spoken', 'experiences', 'Experiences & Wellness', 187),
    ('outdoor_activity', 'Al aire libre', 'Outdoor', 'experiences', 'Experiences & Wellness', 188),
    ('workshops', 'Talleres y clases', 'Workshops & classes', 'experiences', 'Experiences & Wellness', 189),
    ('indoor_activity', 'Actividad bajo techo', 'Indoor activity', 'experiences', 'Experiences & Wellness', 190),
    ('walking_trails', 'Para caminar y correr', 'Walking & running trails', 'experiences', 'Experiences & Wellness', 191),
    ('picnic_friendly', 'Para picnic', 'Picnic friendly', 'experiences', 'Experiences & Wellness', 192),
    ('gift_shop', 'Tienda de regalos', 'Gift shop', 'experiences', 'Experiences & Wellness', 193),
    ('cafe_on_site', 'Café en sitio', 'Café on site', 'experiences', 'Experiences & Wellness', 194),
    -- values (Both)
    ('eco_friendly', 'Eco-friendly', 'Eco-friendly', 'values', 'Both', 195),
    ('woman_owned', 'Negocio de mujeres', 'Woman-owned', 'values', 'Both', 196),
    ('family_owned', 'Negocio familiar', 'Family owned', 'values', 'Both', 197),
    ('non_smoking', 'No fumar', 'Non-smoking', 'values', 'Both', 198),
    ('smoking_area', 'Área de fumar', 'Smoking area', 'values', 'Both', 199),
    ('photography_allowed', 'Fotos permitidas', 'Photography allowed', 'values', 'Both', 200)
  on conflict (slug) do update set
    label_es   = excluded.label_es,
    label_en   = excluded.label_en,
    facet      = excluded.facet,
    section    = excluded.section,
    sort_order = excluded.sort_order;
$function$;

-- Scrub the stale drift row from any place tags (0 today) before deleting it.
update public.places
   set tags = array_remove(tags, 'locally_owned')
 where tags is not null and 'locally_owned' = any(tags);

select public.seed_place_tags();

delete from public.place_tags where slug = 'locally_owned';

notify pgrst, 'reload schema';
