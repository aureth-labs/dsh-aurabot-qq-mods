# 角色素材

三档角色来自用户提供的设定图；透明立绘与闭眼变体经过内置图像工具辅助处理。每张闭眼图只在对应眼部区域用于眨眼，运行时不调用图像模型。源码、原始透明 PNG 与闭眼 PNG 一同分发。

## low

素材：`assets/characters/low.png`、`assets/animations/idle-low-closed.png`。闭眼编辑提示词：

```
Use case: precise-object-edit.
Asset type: closed-eyes animation variant of an existing transparent desktop character.
Input is the edit target. Make one precise change: close BOTH blue eyes in a relaxed, cute natural blink, drawing two delicate curved closed eyelids with matching dark blue eyelashes. Keep her existing small happy mouth exactly as it is, not puffed cheeks. Keep absolutely everything else as close to pixel-identical as possible: exact head position and size, exact entire face proportions, exact hair, body, outfit, hands, whale tail, shoes, pose, original vertical framing, transparent padding and lighting.
Preserve the complete 887x1774 portrait composition and baseline. Do not center differently, do not enlarge the character. The source has transparent space above the hair and below the shoes; preserve that SAME space. Keep the SAME shoulder and facial geometry so this frame can be registered directly over the reference for blinking. Only close the eyelids; no other changes. Genuine transparent background. No text, no background, no shadows, no new objects.
```

## middle

素材：`assets/characters/middle.png`、`assets/animations/idle-middle-closed.png`。闭眼编辑提示词：

```
Use case: precise-object-edit.
Asset type: a blink variant for the MIDDLE-STAGE full-height whale maid desktop character.
The provided transparent image is the edit target. Make ONE exact change: close BOTH blue eyes naturally in a gentle, cute blink, using delicate dark blue curved upper lash lines. Keep the mouth's existing small happy smile exactly unchanged.
Preserve the exact original pose, face and head location, head angle, head scale, all facial geometry except eyelids, every hair strand, floating loop of hair, white lace headband, navy detailed maid dress, whale apron, gloves/cuffs, fingers, legs, shoes and entire whale tail. Keep the SAME 887x1774 full-body composition and anchor position; do not recenter, resize or change transparent padding.
No new shadows, no props, no text, no background. Genuine clean alpha transparency around the full character and through the existing gaps. Keep white clothing opaque. This will be overlaid only around the two eyes to animate a blink, so exact registration to the reference is essential.
```

## high

素材：`assets/characters/high.png`、`assets/animations/idle-high-closed.png`。闭眼编辑提示词：

```
Use case: precise-object-edit.
Asset type: blink variant for the HIGHEST-STAGE full-height blue-haired whale maid desktop character.
The input image is the edit target. Change ONLY BOTH blue eyes to gently closed eyes in a natural, soft blink, with delicate matching dark navy eyelash curves. Keep her small quiet mouth and gentle calm expression, do not make a new smile or puffed cheeks.
Keep everything else as close to pixel-identical as possible: exact face and head location, original head angle, head scale, hair, loop-shaped floating hair tuft, white lace headband, simple navy maid dress, white apron, all limbs, shoes and the ENTIRE huge curved whale tail that wraps behind her legs. Preserve the SAME 887x1774 portrait framing, subject scale, planted shoe baseline and all original transparent spacing. Do not move or recenter the character.
Genuine alpha transparency outside the complete character, including all original gaps between her legs, hair and tail; white apron, skin, lace and shoes remain opaque. No shadow, background, props, text or new detail. Only the closed eyelids should change, so our renderer can register the eyes directly over the input.
```
