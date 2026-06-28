# Receipt Item Classification Skill

Version: 1.0  
Purpose: Classify receipt line items for a personal finance app into stable `main_category`, `sub_category`, and `tags` for item-level spending analysis.

This skill is intended for a local LLM such as Qwen. It assumes OCR/extraction has already been done. The model should only classify already-extracted receipt data.

---

## 1. Core Principles

### 1.1 Classify by item purpose, not by merchant alone

The item's own meaning is the primary signal. Merchant name and receipt context are secondary signals.

Examples:

- Toothpaste bought at REWE is `personal_care.dental_care`, not `groceries`.
- Detergent bought at a supermarket is `household.laundry`, not `groceries`.
- Vitamins bought on Amazon are `health.supplements`, not `retail_goods`.
- A USB cable bought on Amazon is `retail_goods.electronics`, not `digital_subscriptions`.

### 1.2 Separate merchant type from item category

A merchant can describe where the purchase happened. An item category describes what the user bought.

Example:

```json
{
  "merchant": "REWE",
  "merchant_type": "supermarket",
  "raw_name": "ZAHNCREME",
  "main_category": "personal_care",
  "sub_category": "personal_care.dental_care"
}
```

The merchant type can be `supermarket`, but the item category should still be `personal_care.dental_care`.

### 1.3 The same item may belong to different categories depending on consumption context

The model must distinguish between served/on-premise consumption and retail/take-home purchases.

Examples:

- Water in a restaurant receipt: `dining.restaurant` or `dining.bar_nightlife`, with tags such as `drink`, `served_on_premise`, `restaurant_item`.
- Bottled water bought at a supermarket: `groceries.soft_drinks`, with tags such as `drink`, `home_consumption`, `supermarket_item`.
- Coffee at Starbucks: `dining.cafe_coffee`.
- Coffee beans bought at a supermarket: `groceries.pantry_staples` or `groceries.soft_drinks` depending on local taxonomy preference, with tags such as `coffee`, `home_consumption`.

### 1.4 Use controlled vocabulary only

The model must not invent categories. Use only the allowed `main_category`, `sub_category`, and `tags` listed in this skill.

If uncertain, use:

```json
{
  "main_category": "other",
  "sub_category": "other.unknown",
  "tags": ["unknown"],
  "confidence": 0.5
}
```

### 1.5 Preserve every input item exactly once

For each input item:

- Keep `raw_name` exactly unchanged.
- Do not invent items.
- Do not remove items.
- Do not merge items.
- Do not split one item into multiple items.
- Preserve the original item order.

---

## 2. Recommended Output Fields

For each item, output at least:

```json
{
  "raw_name": "string",
  "normalized_name": "string",
  "main_category": "string",
  "sub_category": "string",
  "tags": ["string"],
  "confidence": 0.0,
  "classification_source": "qwen"
}
```

Recommended additional fields if the app supports them:

```json
{
  "merchant_type": "string",
  "transaction_tags": ["string"]
}
```

### Field definitions

- `raw_name`: exact item name from input.
- `normalized_name`: concise English lowercase product name, for example `toothpaste`, `milk`, `detergent`, `bottled water`.
- `main_category`: one allowed main category ID.
- `sub_category`: one allowed subcategory ID under the selected main category.
- `tags`: 1 to 4 allowed lowercase semantic tags.
- `confidence`: number from 0 to 1.
- `classification_source`: always `qwen`.

---

## 3. Allowed Main Categories

Use these exact IDs:

```json
[
  "groceries",
  "dining",
  "household",
  "personal_care",
  "health",
  "transport",
  "travel",
  "housing_utilities",
  "retail_goods",
  "digital_subscriptions",
  "entertainment_leisure",
  "education_work",
  "pets",
  "children_family",
  "gifts_donations",
  "insurance",
  "financial_admin",
  "other"
]
```

---

## 4. Allowed Taxonomy

### 4.1 `groceries` — Groceries & Ingredients

Definition: Food and drink items bought for home or later consumption.

Use for: milk, bread, fruit, vegetables, meat, rice, pasta, snacks, bottled drinks, supermarket alcohol, frozen foods, pantry items.

Do not use for: toothpaste, detergent, toilet paper, shampoo, medicine, pet food, clothing, electronics.

Allowed subcategories:

```json
[
  "groceries.dairy",
  "groceries.bread_bakery",
  "groceries.produce",
  "groceries.meat_seafood",
  "groceries.frozen_food",
  "groceries.pantry_staples",
  "groceries.snacks_sweets",
  "groceries.soft_drinks",
  "groceries.alcohol",
  "groceries.ready_meals",
  "groceries.baby_food",
  "groceries.other_groceries"
]
```

Examples:

- milk, yogurt, cheese → `groceries.dairy`
- bread, rolls, toast → `groceries.bread_bakery`
- banana, apple, tomato → `groceries.produce`
- chicken, beef, fish → `groceries.meat_seafood`
- frozen pizza, frozen vegetables → `groceries.frozen_food`
- rice, pasta, flour, oil, coffee beans, tea → `groceries.pantry_staples`
- chips, chocolate, candy, biscuits → `groceries.snacks_sweets`
- bottled water, cola, juice, soft drinks → `groceries.soft_drinks`
- beer, wine, spirits bought for home consumption → `groceries.alcohol`
- ready-to-heat meals, prepared supermarket meals → `groceries.ready_meals`

---

### 4.2 `dining` — Dining & Prepared Food

Definition: Prepared food or drinks consumed in restaurants, cafes, bars, canteens, bakeries, or delivered/taken away.

Use for: restaurants, cafes, coffee shops, fast food, takeaway, delivery, cafeteria meals, bar drinks, desserts served outside home.

Allowed subcategories:

```json
[
  "dining.restaurant",
  "dining.fast_food",
  "dining.cafe_coffee",
  "dining.bakery_pastry",
  "dining.delivery_takeaway",
  "dining.bar_nightlife",
  "dining.canteen",
  "dining.dessert",
  "dining.other_dining"
]
```

Examples:

- restaurant meal, pizza at restaurant → `dining.restaurant`
- McDonald's, Burger King, kebab shop → `dining.fast_food`
- Starbucks latte, cafe cappuccino → `dining.cafe_coffee`
- croissant from bakery for immediate consumption → `dining.bakery_pastry`
- Uber Eats, Lieferando, takeaway order → `dining.delivery_takeaway`
- cocktail, beer at bar → `dining.bar_nightlife`
- university/work canteen meal → `dining.canteen`
- gelato, cake, dessert shop → `dining.dessert`

---

### 4.3 `household` — Household & Home Supplies

Definition: Non-food household consumables and home maintenance supplies.

Use for: cleaning products, laundry detergent, paper goods, trash bags, kitchen supplies, home repair supplies, batteries, light bulbs, garden items.

Do not use for: rent, electricity, internet bills. Those are `housing_utilities`.

Allowed subcategories:

```json
[
  "household.cleaning",
  "household.laundry",
  "household.paper_goods",
  "household.kitchen_supplies",
  "household.home_essentials",
  "household.furniture_decor",
  "household.tools_hardware",
  "household.garden_plants",
  "household.home_repair_maintenance",
  "household.other_household"
]
```

Examples:

- dish soap, cleaning spray, sponge → `household.cleaning`
- laundry detergent, fabric softener → `household.laundry`
- toilet paper, kitchen paper, tissues → `household.paper_goods`
- pan, foil, baking paper, food storage box → `household.kitchen_supplies`
- batteries, light bulbs, hangers → `household.home_essentials`
- IKEA shelf, decoration, lamp → `household.furniture_decor`
- screwdriver, drill bits → `household.tools_hardware`
- plant soil, flowers, garden tools → `household.garden_plants`

---

### 4.4 `personal_care` — Personal Care & Beauty

Definition: Personal hygiene, grooming, dental care, hair care, skincare, cosmetics, fragrance, and beauty services.

Allowed subcategories:

```json
[
  "personal_care.dental_care",
  "personal_care.hair_care",
  "personal_care.skin_care",
  "personal_care.cosmetics",
  "personal_care.hygiene",
  "personal_care.fragrance",
  "personal_care.grooming_services",
  "personal_care.other_personal_care"
]
```

Examples:

- toothpaste, toothbrush, mouthwash → `personal_care.dental_care`
- shampoo, conditioner, hair gel → `personal_care.hair_care`
- face cream, sunscreen, body lotion → `personal_care.skin_care`
- makeup, lipstick, mascara → `personal_care.cosmetics`
- deodorant, shower gel, soap, sanitary products → `personal_care.hygiene`
- perfume, cologne → `personal_care.fragrance`
- haircut, barber, nail salon → `personal_care.grooming_services`

---

### 4.5 `health` — Health & Medical

Definition: Medicine, healthcare products, pharmacy items, supplements, medical devices, doctor/clinic services, therapy, fitness/wellness.

Allowed subcategories:

```json
[
  "health.medicine",
  "health.pharmacy",
  "health.supplements",
  "health.medical_devices",
  "health.doctor_clinic",
  "health.therapy",
  "health.fitness_wellness",
  "health.other_health"
]
```

Examples:

- ibuprofen, cough syrup, prescription drugs → `health.medicine`
- pharmacy order with unclear specific item → `health.pharmacy`
- vitamin D, protein powder, omega-3 → `health.supplements`
- thermometer, bandage, blood pressure monitor → `health.medical_devices`
- doctor visit, clinic fee → `health.doctor_clinic`
- psychotherapy, physiotherapy → `health.therapy`
- gym, yoga class, wellness treatment → `health.fitness_wellness`

---

### 4.6 `transport` — Transport & Mobility

Definition: Daily mobility and local transportation.

Use for: public transport, trains used for daily mobility, taxi, ride hailing, fuel, parking, car maintenance, bike/scooter.

Allowed subcategories:

```json
[
  "transport.public_transport",
  "transport.train",
  "transport.taxi_ride_hailing",
  "transport.fuel",
  "transport.parking",
  "transport.car_maintenance",
  "transport.bike_scooter",
  "transport.vehicle_admin",
  "transport.other_transport"
]
```

Examples:

- MVV, subway, bus, tram ticket → `transport.public_transport`
- local train, commuter rail → `transport.train`
- Uber, Bolt, taxi → `transport.taxi_ride_hailing`
- Shell fuel, Aral fuel → `transport.fuel`
- parking meter, garage fee → `transport.parking`
- car wash, repair, tires → `transport.car_maintenance`
- bike rental, e-scooter → `transport.bike_scooter`
- vehicle registration, emissions test → `transport.vehicle_admin`

---

### 4.7 `travel` — Travel

Definition: Trip-related spending, including flights, accommodation, long-distance transport for trips, tourism, luggage, visas, activities.

Do not use for daily commute.

Allowed subcategories:

```json
[
  "travel.flights",
  "travel.accommodation",
  "travel.long_distance_train_bus",
  "travel.local_transport",
  "travel.travel_food",
  "travel.activities_tours",
  "travel.luggage_travel_supplies",
  "travel.visa_travel_fees",
  "travel.other_travel"
]
```

Examples:

- airline ticket → `travel.flights`
- hotel, Airbnb, hostel → `travel.accommodation`
- long-distance train/bus for a trip → `travel.long_distance_train_bus`
- airport taxi during trip → `travel.local_transport`
- meal explicitly during travel → `travel.travel_food`
- museum ticket, tour, attraction during trip → `travel.activities_tours`
- suitcase, travel adapter → `travel.luggage_travel_supplies`
- visa fee, travel document fee → `travel.visa_travel_fees`

---

### 4.8 `housing_utilities` — Housing & Utilities

Definition: Rent, mortgage, home utilities, housing-related recurring bills and services.

Use for transaction-level bills rather than normal receipt items.

Allowed subcategories:

```json
[
  "housing_utilities.rent_mortgage",
  "housing_utilities.electricity_gas_water",
  "housing_utilities.internet_phone",
  "housing_utilities.property_fee_tax",
  "housing_utilities.repairs_services",
  "housing_utilities.other_housing"
]
```

Examples:

- rent, mortgage → `housing_utilities.rent_mortgage`
- electricity, gas, water, heating → `housing_utilities.electricity_gas_water`
- home internet, home phone → `housing_utilities.internet_phone`
- property tax, building fee → `housing_utilities.property_fee_tax`
- plumber, electrician, home repair service → `housing_utilities.repairs_services`

---

### 4.9 `retail_goods` — Retail Goods & Durable Shopping

Definition: Discretionary or durable retail goods such as clothing, electronics, books, stationery, sports goods, toys, gifts, luxury items, and general merchandise.

This is not a catch-all for everything bought in a store. Do not use for food, medicine, household consumables, personal care, pet food, or utilities.

Allowed subcategories:

```json
[
  "retail_goods.clothing",
  "retail_goods.shoes_bags_accessories",
  "retail_goods.electronics",
  "retail_goods.books_media",
  "retail_goods.stationery",
  "retail_goods.sports_outdoor",
  "retail_goods.toys_games",
  "retail_goods.general_merchandise",
  "retail_goods.luxury",
  "retail_goods.other_retail_goods"
]
```

Examples:

- shirt, jacket, trousers → `retail_goods.clothing`
- shoes, handbag, belt → `retail_goods.shoes_bags_accessories`
- USB cable, laptop, headphones → `retail_goods.electronics`
- book, magazine, DVD → `retail_goods.books_media`
- notebook, pen, printer paper → `retail_goods.stationery`
- tennis racket, hiking gear → `retail_goods.sports_outdoor`
- board game, toy → `retail_goods.toys_games`
- mixed retail item with unclear purpose → `retail_goods.general_merchandise`
- luxury watch, designer bag → `retail_goods.luxury`

---

### 4.10 `digital_subscriptions` — Digital Services & Subscriptions

Definition: Digital platforms, apps, cloud services, streaming, software, gaming subscriptions, news subscriptions, telecom mobile plans, and recurring digital memberships.

Allowed subcategories:

```json
[
  "digital_subscriptions.streaming",
  "digital_subscriptions.music_audio",
  "digital_subscriptions.gaming",
  "digital_subscriptions.software_apps",
  "digital_subscriptions.cloud_storage",
  "digital_subscriptions.news_media",
  "digital_subscriptions.telecom_mobile_plan",
  "digital_subscriptions.membership_platform",
  "digital_subscriptions.other_digital_subscription"
]
```

Examples:

- Netflix, Disney+, Prime Video → `digital_subscriptions.streaming`
- Spotify, Apple Music → `digital_subscriptions.music_audio`
- Steam purchase, PlayStation subscription → `digital_subscriptions.gaming`
- ChatGPT, Adobe, Notion, app subscription → `digital_subscriptions.software_apps`
- iCloud, Google Drive storage → `digital_subscriptions.cloud_storage`
- newspaper subscription → `digital_subscriptions.news_media`
- mobile phone plan → `digital_subscriptions.telecom_mobile_plan`

---

### 4.11 `entertainment_leisure` — Entertainment & Leisure

Definition: One-off entertainment, cultural activities, hobbies, leisure services, events, sports activities, nightlife not primarily classified as dining.

Allowed subcategories:

```json
[
  "entertainment_leisure.cinema_events",
  "entertainment_leisure.museums_culture",
  "entertainment_leisure.hobbies",
  "entertainment_leisure.sports_activities",
  "entertainment_leisure.nightlife",
  "entertainment_leisure.games_arcades",
  "entertainment_leisure.leisure_services",
  "entertainment_leisure.other_entertainment"
]
```

Examples:

- cinema ticket, concert ticket → `entertainment_leisure.cinema_events`
- museum, exhibition → `entertainment_leisure.museums_culture`
- craft supplies for hobby → `entertainment_leisure.hobbies`
- climbing gym day pass, bowling → `entertainment_leisure.sports_activities`
- club entrance → `entertainment_leisure.nightlife`
- arcade, escape room → `entertainment_leisure.games_arcades`

---

### 4.12 `education_work` — Education & Work

Definition: Learning, courses, study materials, certifications, professional services, office supplies, work equipment, conferences.

Allowed subcategories:

```json
[
  "education_work.tuition_courses",
  "education_work.study_materials",
  "education_work.office_supplies",
  "education_work.professional_services",
  "education_work.work_equipment",
  "education_work.conferences",
  "education_work.certifications",
  "education_work.other_education_work"
]
```

Examples:

- university tuition, online course → `education_work.tuition_courses`
- textbook, study book → `education_work.study_materials`
- printer paper, office supplies for work → `education_work.office_supplies`
- professional service fee → `education_work.professional_services`
- work keyboard, monitor, chair → `education_work.work_equipment`
- conference ticket → `education_work.conferences`
- exam fee, certificate fee → `education_work.certifications`

---

### 4.13 `pets` — Pets

Definition: Pet food, pet supplies, vet bills, pet services.

Allowed subcategories:

```json
[
  "pets.pet_food",
  "pets.pet_care_supplies",
  "pets.veterinary",
  "pets.pet_services",
  "pets.other_pets"
]
```

Examples:

- cat food, dog food → `pets.pet_food`
- cat litter, pet shampoo, leash → `pets.pet_care_supplies`
- veterinary bill → `pets.veterinary`
- grooming, pet boarding → `pets.pet_services`

---

### 4.14 `children_family` — Children & Family

Definition: Childcare, baby supplies, kids clothing, kids toys, children's education and family support.

Allowed subcategories:

```json
[
  "children_family.childcare",
  "children_family.baby_food_formula",
  "children_family.baby_supplies",
  "children_family.kids_clothing",
  "children_family.kids_toys",
  "children_family.kids_education_activities",
  "children_family.family_support",
  "children_family.other_family"
]
```

Examples:

- kindergarten fee, babysitter → `children_family.childcare`
- baby formula, baby food → `children_family.baby_food_formula`
- diapers, baby wipes → `children_family.baby_supplies`
- kids clothing → `children_family.kids_clothing`
- kids toy → `children_family.kids_toys`
- children's class/activity → `children_family.kids_education_activities`

---

### 4.15 `gifts_donations` — Gifts & Donations

Definition: Gifts, donations, tips, celebrations, social giving.

Allowed subcategories:

```json
[
  "gifts_donations.gifts",
  "gifts_donations.donations_charity",
  "gifts_donations.tips",
  "gifts_donations.celebrations",
  "gifts_donations.other_gifts_donations"
]
```

Examples:

- birthday gift → `gifts_donations.gifts`
- charity donation → `gifts_donations.donations_charity`
- restaurant tip as separate line → `gifts_donations.tips`
- wedding gift or party contribution → `gifts_donations.celebrations`

---

### 4.16 `insurance` — Insurance

Definition: Insurance payments.

Allowed subcategories:

```json
[
  "insurance.health_insurance",
  "insurance.car_insurance",
  "insurance.home_insurance",
  "insurance.travel_insurance",
  "insurance.life_insurance",
  "insurance.liability_insurance",
  "insurance.other_insurance"
]
```

Examples:

- health insurance → `insurance.health_insurance`
- car insurance → `insurance.car_insurance`
- home insurance → `insurance.home_insurance`
- travel insurance → `insurance.travel_insurance`
- liability insurance → `insurance.liability_insurance`

---

### 4.17 `financial_admin` — Financial & Administrative

Definition: Bank fees, card fees, ATM fees, interest, loan payments, taxes, fines, legal/accounting, government services, receipt adjustments, deposits/refunds.

Allowed subcategories:

```json
[
  "financial_admin.bank_fee",
  "financial_admin.card_fee",
  "financial_admin.atm_fee",
  "financial_admin.interest",
  "financial_admin.loan_payment",
  "financial_admin.taxes",
  "financial_admin.fines_penalties",
  "financial_admin.legal_accounting",
  "financial_admin.government_services",
  "financial_admin.deposits_refunds",
  "financial_admin.discounts_adjustments",
  "financial_admin.service_delivery_fees",
  "financial_admin.other_financial_admin"
]
```

Examples:

- bank account fee → `financial_admin.bank_fee`
- card processing fee → `financial_admin.card_fee`
- ATM fee → `financial_admin.atm_fee`
- loan interest → `financial_admin.interest`
- loan repayment → `financial_admin.loan_payment`
- taxes → `financial_admin.taxes`
- traffic fine → `financial_admin.fines_penalties`
- lawyer/accounting fee → `financial_admin.legal_accounting`
- government document fee → `financial_admin.government_services`
- bottle deposit/PFAND, deposit return → `financial_admin.deposits_refunds`
- coupon, discount, rebate, voucher adjustment → `financial_admin.discounts_adjustments`
- delivery fee, service fee as separate line → `financial_admin.service_delivery_fees`

---

### 4.18 `other` — Other / Unknown

Definition: Use only when no reliable category can be inferred.

Allowed subcategories:

```json
[
  "other.other",
  "other.unknown"
]
```

Use `other.unknown` for unclear item codes such as `AKTION ART. 12345` when no item meaning can be inferred.

---

## 5. Allowed Tags

Use 1 to 4 values from this list only:

```json
[
  "food",
  "drink",
  "coffee",
  "tea",
  "snack",
  "dessert",
  "alcohol",
  "ready_to_eat",
  "home_cooking",
  "home_consumption",
  "served_on_premise",
  "restaurant_item",
  "cafe_item",
  "delivery",
  "takeaway",
  "daily_necessity",
  "non_essential",
  "hygiene",
  "dental",
  "hair_care",
  "skincare",
  "cosmetics",
  "cleaning",
  "laundry",
  "paper_goods",
  "household",
  "medicine",
  "supplements",
  "health",
  "pet",
  "child_related",
  "clothing",
  "electronics",
  "book",
  "stationery",
  "gift",
  "transport",
  "commute",
  "fuel",
  "parking",
  "travel",
  "accommodation",
  "subscription",
  "digital_service",
  "entertainment",
  "education",
  "work_related",
  "fee",
  "tax",
  "insurance",
  "recurring",
  "supermarket_item",
  "retail_item",
  "marketplace_item",
  "deposit",
  "refund",
  "discount",
  "unknown"
]
```

Tag guidance:

- Food bought for home: include `food` and often `home_consumption`.
- Restaurant/cafe food: include `restaurant_item` or `cafe_item`, and often `served_on_premise`.
- Cleaning/laundry: include `cleaning`, `laundry`, or `household`.
- Personal care: include `hygiene`, `dental`, `hair_care`, `skincare`, or `cosmetics`.
- Subscription/digital services: include `subscription` and/or `digital_service`.
- Unknown items: use only `unknown`.

---

## 6. Decision Rules for Ambiguous Cases

### 6.1 Groceries vs Dining

- If food or drink is served in a restaurant, cafe, bar, canteen, or takeaway/delivery context, classify under `dining`.
- If food or drink is bought from a supermarket, grocery store, convenience store, or retail shop for later consumption, classify under `groceries`.

Examples:

- `Still Water` at Italian Restaurant → `dining.restaurant`
- `Volvic 6x1.5L` at REWE → `groceries.soft_drinks`
- `Latte` at Starbucks → `dining.cafe_coffee`
- `Coffee beans` at supermarket → `groceries.pantry_staples`

### 6.2 Groceries vs Household

- Groceries is food and drink only.
- Household is non-food household consumables and home supplies.

Examples:

- Milk → `groceries.dairy`
- Toilet paper → `household.paper_goods`
- Laundry detergent → `household.laundry`
- Trash bags → `household.home_essentials`

### 6.3 Household vs Housing & Utilities

- Household = physical home supplies and consumables.
- Housing & Utilities = rent, electricity, gas, water, internet, property bills, home service bills.

Examples:

- Dish soap → `household.cleaning`
- Electricity bill → `housing_utilities.electricity_gas_water`
- Internet bill → `housing_utilities.internet_phone`

### 6.4 Retail Goods is not a catch-all

Use `retail_goods` only for durable or discretionary retail products such as clothing, electronics, books, stationery, sports goods, toys, gifts, and general merchandise.

Do not use `retail_goods` for:

- Food/drinks → `groceries` or `dining`
- Toothpaste/shampoo → `personal_care`
- Medicine/vitamins → `health`
- Detergent/toilet paper → `household`
- Pet food → `pets`

### 6.5 Marketplace purchases

For Amazon, eBay, AliExpress, PayPal, Klarna, or similar marketplace/payment merchants:

- Do not classify as `retail_goods` by default.
- Classify by the item purpose if item details are available.
- If item details are unavailable, use low confidence and `other.unknown` or a broad transaction-level category.

Examples:

- Amazon USB cable → `retail_goods.electronics`
- Amazon vitamins → `health.supplements`
- Amazon cat food → `pets.pet_food`
- Amazon Prime → `digital_subscriptions.streaming` or `digital_subscriptions.membership_platform`

### 6.6 Drugstores and pharmacies

For dm, Rossmann, CVS, Walgreens, Boots, pharmacies, and similar merchants:

- Classify by item purpose.
- These stores can contain personal care, health, household, groceries, baby supplies, and pet items.

Examples:

- Shampoo → `personal_care.hair_care`
- Toothpaste → `personal_care.dental_care`
- Vitamin D → `health.supplements`
- Detergent → `household.laundry`
- Baby wipes → `children_family.baby_supplies`

### 6.7 Supermarket mixed baskets

A supermarket receipt can contain multiple categories. Do not force all items into groceries.

Examples:

- Milk → `groceries.dairy`
- Chocolate → `groceries.snacks_sweets`
- Toothpaste → `personal_care.dental_care`
- Detergent → `household.laundry`
- Dog food → `pets.pet_food`

### 6.8 Fees, discounts, deposits, and adjustments

Receipt lines such as bottle deposits, refunds, coupons, discounts, tips, delivery fees, service fees, or card fees are not normal products.

Examples:

- PFAND / bottle deposit → `financial_admin.deposits_refunds`, tags `deposit`
- coupon / discount / Rabatt → `financial_admin.discounts_adjustments`, tags `discount`
- delivery fee / service fee → `financial_admin.service_delivery_fees`, tags `fee`
- tip → `gifts_donations.tips`, tags `fee`

---

## 7. Confidence Guidelines

Use calibrated confidence, not always high confidence.

- `0.90 - 1.00`: Clear and common item, category is highly certain.
- `0.75 - 0.89`: Likely correct, but item/merchant context could allow another interpretation.
- `0.50 - 0.74`: Ambiguous or inferred from weak context.
- `< 0.50`: Unclear item, unknown abbreviation, insufficient context. Prefer `other.unknown`.

Examples:

- `MILCH 1.5%` → `groceries.dairy`, confidence around `0.95`.
- `ZAHNCREME` → `personal_care.dental_care`, confidence around `0.90`.
- `AKTION ART. 12345` → `other.unknown`, confidence around `0.30`.

---

## 8. Validation Rules

After the model produces JSON, the application should validate:

1. The number of output items equals the number of input items.
2. Each `raw_name` exactly matches one input item name in the same order.
3. `main_category` is in the allowed main category list.
4. `sub_category` belongs to the selected `main_category`.
5. All tags are in `ALLOWED_TAGS`.
6. `confidence` is a number between 0 and 1.
7. `classification_source` is exactly `qwen`.

If validation fails, either retry once with a stricter prompt or replace invalid fields with:

```json
{
  "main_category": "other",
  "sub_category": "other.unknown",
  "tags": ["unknown"],
  "confidence": 0.3,
  "classification_source": "qwen"
}
```

---

## 9. Recommended Runtime Prompt Template

Use this as the actual Qwen prompt. Insert your extracted receipt payload into `{PAYLOAD_JSON}`.

```text
You classify receipt line items for a personal finance app.
Use only the merchant, currency, item names, quantities, item amounts, and receipt context provided in the input.
Return strict JSON only. Do not include markdown, comments, or explanations.

Hard rules:
- Preserve every input item exactly once and keep raw_name unchanged.
- Do not invent, merge, split, remove, or reorder items.
- normalized_name must be concise English lowercase.
- main_category must be exactly one allowed main category ID from this skill.
- sub_category must be exactly one allowed subcategory ID under the selected main_category.
- tags must contain 1 to 4 values from the allowed tag list.
- confidence must be a number from 0 to 1.
- classification_source must always be "qwen".
- Classify item-level categories by item purpose and consumption context, not by merchant type alone.
- Merchant is context only. Do not classify all items as the merchant category.
- If unclear, use main_category "other", sub_category "other.unknown", tags ["unknown"], and confidence <= 0.5.

Boundary rules:
- Groceries means food and drink for home or later consumption.
- Dining means prepared food/drinks served in restaurants, cafes, bars, canteens, delivery, or takeaway contexts.
- Household means non-food home supplies such as cleaning, laundry, paper goods, kitchen supplies, tools, and home maintenance supplies.
- Housing & Utilities means rent, electricity, gas, water, heating, internet, property bills, and housing-related service bills.
- Retail Goods means durable/discretionary retail goods such as clothing, electronics, books, stationery, sports goods, toys, gifts, luxury, and general merchandise.
- Personal Care means hygiene, dental care, hair care, skin care, cosmetics, fragrance, and grooming.
- Health means medicine, supplements, medical devices, pharmacy, doctor/clinic, therapy, and wellness.
- If a food or drink item is served in a restaurant/cafe/bar, classify it under dining.
- If a food or drink item is bought from a supermarket/grocery store for later consumption, classify it under groceries.
- For Amazon/marketplace/payment merchants, classify by item purpose, not as retail_goods by default.

Input:
{PAYLOAD_JSON}

Output schema:
{
  "merchant_type": "string",
  "transaction_tags": ["string"],
  "items": [
    {
      "raw_name": "string",
      "normalized_name": "string",
      "main_category": "string",
      "sub_category": "string",
      "tags": ["string"],
      "confidence": 0.0,
      "classification_source": "qwen"
    }
  ]
}
```

---

## 10. Example

Input:

```json
{
  "merchant": "Coffee House",
  "currency": "EUR",
  "amount": 27.8,
  "items": [
    {"name": "Milk", "price": 1.29, "quantity": 1},
    {"name": "Eggs", "price": 2.99, "quantity": 1},
    {"name": "Bread", "price": 2.49, "quantity": 1},
    {"name": "Detergent", "price": 4.99, "quantity": 1}
  ]
}
```

Output:

```json
{
  "merchant_type": "unknown",
  "transaction_tags": ["mixed_basket"],
  "items": [
    {
      "raw_name": "Milk",
      "normalized_name": "milk",
      "main_category": "groceries",
      "sub_category": "groceries.dairy",
      "tags": ["food", "home_consumption", "daily_necessity"],
      "confidence": 0.94,
      "classification_source": "qwen"
    },
    {
      "raw_name": "Eggs",
      "normalized_name": "eggs",
      "main_category": "groceries",
      "sub_category": "groceries.other_groceries",
      "tags": ["food", "home_cooking", "daily_necessity"],
      "confidence": 0.89,
      "classification_source": "qwen"
    },
    {
      "raw_name": "Bread",
      "normalized_name": "bread",
      "main_category": "groceries",
      "sub_category": "groceries.bread_bakery",
      "tags": ["food", "home_consumption", "daily_necessity"],
      "confidence": 0.93,
      "classification_source": "qwen"
    },
    {
      "raw_name": "Detergent",
      "normalized_name": "detergent",
      "main_category": "household",
      "sub_category": "household.laundry",
      "tags": ["laundry", "household", "cleaning"],
      "confidence": 0.95,
      "classification_source": "qwen"
    }
  ]
}
```

---

## 11. Implementation Notes

Recommended data strategy:

- Keep the original receipt and original items unchanged.
- Save classification as derived fields.
- Save item-level records in a flat `flo_items` index for analytics.
- Store stable category IDs, not only display names.
- Let the UI map IDs to localized names later.
- Allow user corrections to override future model predictions.

Recommended minimum item record:

```json
{
  "id": "item_uuid",
  "expense_id": "tx_uuid",
  "merchant": "REWE",
  "raw_name": "ZAHNCREME",
  "normalized_name": "toothpaste",
  "quantity": 1,
  "amount": 3.99,
  "currency": "EUR",
  "date": "2026-06-28",
  "time": "18:42",
  "datetime": "2026-06-28T18:42:00+02:00",
  "main_category": "personal_care",
  "sub_category": "personal_care.dental_care",
  "tags": ["hygiene", "dental", "daily_necessity"],
  "confidence": 0.91,
  "classification_source": "qwen"
}
```
