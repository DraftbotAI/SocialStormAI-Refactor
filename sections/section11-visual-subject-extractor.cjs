// ===========================================================
// SECTION 11: GPT VISUAL SUBJECT EXTRACTOR (PROD VERSION)
// Returns the top 4 visual subject candidates for any script line.
// Order: Exact > Contextual > Symbolic > General Fallback
// Bulletproof: Handles blank, weird, or failed GPT cases.
// Super max logging, deterministic, no silent failures.
// ===========================================================

const { ChatGPTAPI } = require('chatgpt'); // Or your preferred OpenAI SDK client
const path = require('path');
const fs = require('fs');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('[11][FATAL] OPENAI_API_KEY not set in env!');

const gpt = new ChatGPTAPI({ apiKey });

console.log('[11][INIT] Visual Subject Extractor module loaded');

async function extractVisualSubjects(line, mainTopic) {
  console.log(`[11][INPUT] Script line: "${line}"`);
  console.log(`[11][INPUT] Main topic: "${mainTopic}"`);

  if (!line || typeof line !== 'string' || !line.trim()) {
    console.warn('[11][WARN] Blank/invalid line. Returning main topic as fallback.');
    return [mainTopic, mainTopic, mainTopic, mainTopic];
  }

  const prompt = `
You are a world-class viral video editor for TikTok, Reels, and Shorts. For each line of a script, your ONLY job is to pick the 4 best possible VISUAL subjects to show in that scene. 

RULES:
- Only return objects, places, people, or actions that can be LITERALLY SHOWN ON SCREEN.
- Ignore all metaphors, jokes, emotions, abstract concepts, or invisible things.
- If a line is not visually showable, use the main topic as fallback.
- Each answer should be concrete, visual, and unambiguous.

Return EXACTLY 4, in order: primary, context, fallback, general.  
Output ONLY a numbered list. No intro, no explanation, no extra info.

EXAMPLES:

Line: "You’ll never believe what’s hidden inside the Statue of Liberty’s basement..."
Main topic: "Statue of Liberty"
1. Statue of Liberty
2. Statue of Liberty basement
3. Underground storage room
4. Old artifacts in storage

Line: "The Eiffel Tower isn't just for views—it's a labyrinth of secrets"
Main topic: "Eiffel Tower"
1. Eiffel Tower
2. Aerial view of the Eiffel Tower
3. Paris skyline from the tower
4. Close-up of Eiffel Tower structure

Line: "First, chop the onions and garlic."
Main topic: "Cooking"
1. Chopped onions
2. Garlic cloves
3. Chef chopping vegetables
4. Cutting board with vegetables

Line: "Now sauté everything until golden brown."
Main topic: "Cooking"
1. Sauté pan on stove
2. Onions and garlic in pan
3. Wooden spatula stirring food
4. Pan with golden-brown food

Line: "Steph Curry pulls up from deep."
Main topic: "NBA basketball"
1. Steph Curry shooting a 3-pointer
2. Golden State Warriors court
3. Crowd watching basketball game
4. Basketball in mid-air

Line: "Check your credit card statement for these charges."
Main topic: "Personal finance"
1. Credit card statement paper
2. Hand holding credit card
3. Online banking screen
4. Calculator and bills on table

Line: "Always wear sunscreen, even on cloudy days."
Main topic: "Skin care"
1. Person applying sunscreen to face
2. Sunscreen bottle
3. Sun shining behind clouds
4. Close-up of skin

Line: "Let's hike to the top of Angel's Landing."
Main topic: "Travel"
1. Angel's Landing mountain
2. People hiking on a trail
3. Panoramic view from summit
4. National park landscape

Line: "Tie the scarf with a simple knot for a classic look."
Main topic: "Fashion"
1. Person tying a scarf
2. Close-up of scarf knot
3. Scarf draped on mannequin
4. Various scarf styles

Line: "Plug the HDMI cable into your laptop and TV."
Main topic: "Tech tutorial"
1. HDMI cable
2. Hand plugging cable into laptop
3. Laptop and TV side-by-side
4. HDMI ports on devices

Line: "Fold the paper in half and crease firmly."
Main topic: "DIY crafts"
1. Hands folding paper
2. Paper being creased
3. Close-up of origami fold
4. Stack of folded papers

Line: "Whisk the eggs and sugar until fluffy."
Main topic: "Baking"
1. Whisk in bowl with eggs and sugar
2. Fluffy egg mixture
3. Hand whisking ingredients
4. Baking setup on kitchen counter

Line: "Decorate the Christmas tree with lights."
Main topic: "Christmas"
1. Christmas tree with lights
2. Person hanging ornaments
3. Box of decorations
4. Living room decorated for holidays

Line: "Do 10 pushups to finish strong."
Main topic: "Home workout"
1. Person doing pushups
2. Fitness mat on floor
3. Trainer demonstrating exercise
4. Close-up of hands on mat

Line: "Pour the coffee and enjoy your morning."
Main topic: "Morning routine"
1. Coffee being poured into mug
2. Steaming cup of coffee
3. Breakfast table setup
4. Sunlight through kitchen window

Line: "Click the subscribe button to stay updated."
Main topic: "YouTube channel"
1. Mouse cursor on subscribe button
2. YouTube page on laptop
3. Notification bell icon
4. Person watching video on phone

Line: "Slice the avocado and remove the pit."
Main topic: "Healthy eating"
1. Sliced avocado
2. Knife removing avocado pit
3. Cutting board with avocado halves
4. Bowl of fresh avocado slices

Line: "The puppy wags its tail when it sees you."
Main topic: "Cute animals"
1. Puppy wagging tail
2. Dog looking up at person
3. Owner petting puppy
4. Dog park scene

NOW RETURN:
Line: "${line}"
Main topic: "${mainTopic}"
`;

  try {
    const res = await gpt.sendMessage(prompt);
    let list = [];
    if (res && typeof res.text === 'string') {
      list = res.text
        .trim()
        .split('\n')
        .map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/^- /, '').trim())
        .filter(Boolean);
    }
    // Always return 4 items, falling back to mainTopic if needed
    while (list.length < 4) list.push(mainTopic);
    if (list.length > 4) list = list.slice(0, 4);

    console.log('[11][RESULT] Visual subjects:', list);
    return list;
  } catch (err) {
    console.error('[11][ERROR] GPT visual extraction failed:', err);
    return [mainTopic, mainTopic, mainTopic, mainTopic]; // Ultimate fallback
  }
}

module.exports = { extractVisualSubjects };
