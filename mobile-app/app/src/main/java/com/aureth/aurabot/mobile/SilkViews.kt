package com.aureth.aurabot.mobile

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import kotlin.math.PI
import kotlin.math.sin

/**
 * 原生界面的视觉组件库：颜色全部来自 colors.xml（浅/深模式自动切换），不写死任何色值。
 * 统一圆角（按钮/输入框 14dp，卡片 20dp）、按压缩放 0.97 + 涟漪、细线进度与冷启动品牌波纹。
 */
object SilkUi {
    val EASE_OUT = DecelerateInterpolator(1.6f)

    fun dp(ctx: Context, v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

    fun dpF(ctx: Context, v: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics)

    fun color(ctx: Context, resId: Int): Int = ContextCompat.getColor(ctx, resId)

    /** 重要操作（扫码成功、配对连接）触发轻微震动反馈。 */
    fun hapticConfirm(view: View?) {
        view ?: return
        val flag = if (Build.VERSION.SDK_INT >= 30) {
            HapticFeedbackConstants.CONFIRM
        } else {
            HapticFeedbackConstants.VIRTUAL_KEY
        }
        view.performHapticFeedback(flag)
    }

    fun hapticClick(view: View?) {
        view?.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    }

    /** 为所有可点击控件附上按压 0.97 缩放回弹效果（不吞掉原有点击监听）。 */
    @SuppressLint("ClickableViewAccessibility")
    fun attachPressScale(view: View, scaleDown: Float = 0.97f) {
        view.setOnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    v.animate().cancel()
                    v.animate().scaleX(scaleDown).scaleY(scaleDown).setDuration(90).setInterpolator(EASE_OUT).start()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.animate().cancel()
                    v.animate().scaleX(1f).scaleY(1f).setDuration(170).setInterpolator(EASE_OUT).start()
                }
            }
            false
        }
    }

    fun rippleRect(ctx: Context, fillColor: Int, rippleColor: Int, radiusDp: Float, strokeColor: Int = Color.TRANSPARENT, strokeWidthDp: Float = 0f): RippleDrawable {
        val radiusPx = dpF(ctx, radiusDp)
        val content = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radiusPx
            setColor(fillColor)
            if (strokeWidthDp > 0f && strokeColor != Color.TRANSPARENT) {
                setStroke(dp(ctx, strokeWidthDp).coerceAtLeast(1), strokeColor)
            }
        }
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radiusPx
            setColor(Color.WHITE)
        }
        return RippleDrawable(ColorStateList.valueOf(rippleColor), content, mask)
    }

    fun glassCardBackground(ctx: Context, radiusDp: Float = 20f): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dpF(ctx, radiusDp)
            setColor(color(ctx, R.color.surface_glass))
            setStroke(dp(ctx, 1f).coerceAtLeast(1), color(ctx, R.color.stroke))
        }
    }

    fun pillBackground(ctx: Context, fillRes: Int = R.color.surface_subtle, strokeRes: Int = R.color.stroke): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dpF(ctx, 999f)
            setColor(color(ctx, fillRes))
            setStroke(dp(ctx, 1f).coerceAtLeast(1), color(ctx, strokeRes))
        }
    }

    fun primaryButton(ctx: Context, label: String, iconRes: Int? = null, onClick: (View) -> Unit): View {
        val labelView = TextView(ctx).apply {
            text = label
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
            setTextColor(color(ctx, R.color.btn_fg))
            typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
            isSingleLine = true
        }
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            minimumHeight = dp(ctx, 52f)
            setPadding(dp(ctx, 20f), dp(ctx, 13f), dp(ctx, 20f), dp(ctx, 13f))
            background = rippleRect(
                ctx,
                fillColor = color(ctx, R.color.accent),
                rippleColor = color(ctx, R.color.ripple_on_accent),
                radiusDp = 14f
            )
            if (iconRes != null) {
                val icon = ImageView(ctx).apply {
                    setImageResource(iconRes)
                    setColorFilter(color(ctx, R.color.btn_fg))
                }
                val size = dp(ctx, 18f)
                addView(icon, LinearLayout.LayoutParams(size, size).apply {
                    rightMargin = dp(ctx, 8f)
                })
            }
            addView(labelView, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ))
            contentDescription = label
            elevation = dpF(ctx, 4f)
            isClickable = true
            isFocusable = true
            attachPressScale(this)
            setOnClickListener { v ->
                hapticClick(v)
                onClick(v)
            }
        }
    }

    fun secondaryButton(ctx: Context, label: String, outlined: Boolean = true, onClick: (View) -> Unit): TextView {
        return TextView(ctx).apply {
            text = label
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(color(ctx, if (outlined) R.color.fg else R.color.muted))
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            minHeight = dp(ctx, if (outlined) 52f else 44f)
            setPadding(dp(ctx, 18f), dp(ctx, 11f), dp(ctx, 18f), dp(ctx, 11f))
            background = rippleRect(
                ctx,
                fillColor = if (outlined) color(ctx, R.color.surface) else Color.TRANSPARENT,
                rippleColor = color(ctx, R.color.ripple_light),
                radiusDp = 14f,
                strokeColor = if (outlined) color(ctx, R.color.stroke_strong) else Color.TRANSPARENT,
                strokeWidthDp = if (outlined) 1f else 0f
            )
            isClickable = true
            isFocusable = true
            attachPressScale(this)
            setOnClickListener { v ->
                hapticClick(v)
                onClick(v)
            }
        }
    }

    fun styledInput(ctx: Context, hintText: String): EditText {
        return EditText(ctx).apply {
            hint = hintText
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(color(ctx, R.color.fg))
            setHintTextColor(color(ctx, R.color.muted))
            minHeight = dp(ctx, 50f)
            setPadding(dp(ctx, 16f), dp(ctx, 12f), dp(ctx, 16f), dp(ctx, 12f))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dpF(ctx, 14f)
                setColor(color(ctx, R.color.surface_subtle))
                setStroke(dp(ctx, 1f).coerceAtLeast(1), color(ctx, R.color.stroke))
            }
            setOnFocusChangeListener { v, hasFocus ->
                val bg = v.background as? GradientDrawable ?: return@setOnFocusChangeListener
                if (hasFocus) {
                    bg.setColor(color(ctx, R.color.surface))
                    bg.setStroke(dp(ctx, 1.5f).coerceAtLeast(2), color(ctx, R.color.accent))
                } else {
                    bg.setColor(color(ctx, R.color.surface_subtle))
                    bg.setStroke(dp(ctx, 1f).coerceAtLeast(1), color(ctx, R.color.stroke))
                }
            }
        }
    }

    fun space(ctx: Context, heightDp: Float): View = View(ctx).apply {
        layoutParams = LinearLayout.LayoutParams(1, dp(ctx, heightDp))
    }

    /** 页面切换：淡入加上移 14dp（220ms，减速曲线），避免生硬替换。 */
    fun animateEnter(view: View) {
        view.alpha = 0f
        view.translationY = dpF(view.context, 14f)
        view.animate()
            .alpha(1f)
            .translationY(0f)
            .setDuration(220)
            .setInterpolator(EASE_OUT)
            .start()
    }
}

/**
 * 顶部柔和极光光晕：贴合网页端 .orb 氛围与 Silk 浅净通透感，色值取自 colors.xml。
 */
class AuroraBackdropView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var softColor = SilkUi.color(context, R.color.accent_soft)
    private var glowColor = SilkUi.color(context, R.color.accent_glow)

    fun refreshThemeColors() {
        softColor = SilkUi.color(context, R.color.accent_soft)
        glowColor = SilkUi.color(context, R.color.accent_glow)
        updateShader()
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        updateShader()
    }

    private fun updateShader() {
        if (width <= 0 || height <= 0) return
        val cx = width * 0.42f
        val cy = height * 0.24f
        val radius = (height * 0.23f).coerceAtLeast(1f)
        paint.shader = RadialGradient(
            cx, cy, radius,
            intArrayOf(glowColor, softColor, Color.TRANSPARENT),
            floatArrayOf(0f, 0.45f, 1f),
            Shader.TileMode.CLAMP
        )
    }

    override fun onDraw(canvas: Canvas) {
        if (paint.shader != null) {
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
        }
    }
}

/**
 * Aurabot 品牌标志：圆润徽章内的聊天气泡与两条流动波纹。
 * 冷启动时播放不超过 600ms 的波纹流动与光泽扫过动画，随后直接进入页面。
 */
class BrandMarkView(context: Context) : View(context) {
    private val badgePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bubblePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val wavePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val sheenPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val badgeRect = RectF()
    private val clipPath = Path()
    private val bubblePath = Path()
    private val wave1Path = Path()
    private val wave2Path = Path()

    private var wavePhase = 0f
    private var sheenProgress = -1f
    private var coldAnimator: ValueAnimator? = null

    init {
        refreshThemeColors()
    }

    fun refreshThemeColors() {
        val accent = SilkUi.color(context, R.color.accent)
        val btnFg = SilkUi.color(context, R.color.btn_fg)
        val glow = SilkUi.color(context, R.color.accent_glow)
        badgePaint.color = accent
        bubblePaint.color = btnFg
        wavePaint.color = accent
        glowPaint.color = glow
        invalidate()
    }

    /** 播放冷启动波纹动画（总计 480ms，不超过 600ms），结束即回调。 */
    fun playColdStart(onFinished: () -> Unit) {
        coldAnimator?.cancel()
        val anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 480L
            interpolator = DecelerateInterpolator(1.4f)
            addUpdateListener { va ->
                val t = va.animatedValue as Float
                wavePhase = t * (2f * PI.toFloat())
                sheenProgress = t
                invalidate()
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                private var cancelled = false
                override fun onAnimationCancel(animation: android.animation.Animator) { cancelled = true }
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    sheenProgress = -1f
                    wavePhase = 0f
                    invalidate()
                    if (!cancelled) onFinished()
                }
            })
        }
        coldAnimator = anim
        anim.start()
    }

    override fun onDetachedFromWindow() {
        coldAnimator?.cancel()
        coldAnimator = null
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        val size = minOf(w, h)
        val pad = size * 0.14f
        val left = (w - size) / 2f + pad
        val top = (h - size) / 2f + pad
        val right = left + size - pad * 2f
        val bottom = top + size - pad * 2f
        val box = right - left
        val corner = box * 0.28f

        // 柔和底光
        glowPaint.shader = RadialGradient(
            w / 2f, h / 2f, size * 0.56f,
            intArrayOf(SilkUi.color(context, R.color.accent_glow), Color.TRANSPARENT),
            floatArrayOf(0.35f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.drawCircle(w / 2f, h / 2f, size * 0.54f, glowPaint)

        // 主徽章圆角矩形
        badgeRect.set(left, top, right, bottom)
        canvas.drawRoundRect(badgeRect, corner, corner, badgePaint)

        // 气泡（按 108 坐标系等比缩放至徽章内）
        val s = box / 72f
        val ox = left + box * 0.5f - 54f * s
        val oy = top + box * 0.5f - 53f * s
        bubblePath.reset()
        bubblePath.moveTo(ox + 38f * s, oy + 32f * s)
        bubblePath.lineTo(ox + 70f * s, oy + 32f * s)
        bubblePath.quadTo(ox + 78f * s, oy + 32f * s, ox + 78f * s, oy + 40f * s)
        bubblePath.lineTo(ox + 78f * s, oy + 58f * s)
        bubblePath.quadTo(ox + 78f * s, oy + 66f * s, ox + 70f * s, oy + 66f * s)
        bubblePath.lineTo(ox + 50f * s, oy + 66f * s)
        bubblePath.lineTo(ox + 40f * s, oy + 74f * s)
        bubblePath.lineTo(ox + 40f * s, oy + 66f * s)
        bubblePath.lineTo(ox + 38f * s, oy + 66f * s)
        bubblePath.quadTo(ox + 30f * s, oy + 66f * s, ox + 30f * s, oy + 58f * s)
        bubblePath.lineTo(ox + 30f * s, oy + 40f * s)
        bubblePath.quadTo(ox + 30f * s, oy + 32f * s, ox + 38f * s, oy + 32f * s)
        bubblePath.close()
        canvas.drawPath(bubblePath, bubblePaint)

        // 两条流动的声波
        wavePaint.strokeWidth = 3.4f * s
        drawWave(canvas, wave1Path, ox, oy, s, baseY = 45f, phaseOffset = 0f)
        drawWave(canvas, wave2Path, ox, oy, s, baseY = 54f, phaseOffset = 1.0f)

        // 流动高光掠过徽章
        if (sheenProgress in 0f..1f) {
            clipPath.reset()
            clipPath.addRoundRect(badgeRect, corner, corner, Path.Direction.CW)
            canvas.save()
            canvas.clipPath(clipPath)
            val sweepX = left - box * 0.6f + sheenProgress * (box * 2.2f)
            val whiteTranslucent = ColorUtils.setAlphaComponent(SilkUi.color(context, R.color.btn_fg), 72)
            sheenPaint.shader = LinearGradient(
                sweepX - box * 0.35f, top,
                sweepX + box * 0.35f, bottom,
                intArrayOf(Color.TRANSPARENT, whiteTranslucent, Color.TRANSPARENT),
                floatArrayOf(0f, 0.5f, 1f),
                Shader.TileMode.CLAMP
            )
            canvas.drawRect(badgeRect, sheenPaint)
            canvas.restore()
        }
    }

    private fun drawWave(canvas: Canvas, path: Path, ox: Float, oy: Float, s: Float, baseY: Float, phaseOffset: Float) {
        path.reset()
        val steps = 20
        val startX = 40f
        val span = 28f
        for (i in 0..steps) {
            val u = i.toFloat() / steps
            val x = ox + (startX + span * u) * s
            val amp = 2.6f * sin(u * PI.toFloat())
            val y = oy + (baseY - amp * sin(u * 2.6f * PI.toFloat() - wavePhase + phaseOffset)) * s
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        canvas.drawPath(path, wavePaint)
    }
}

/**
 * 顶部细线加载指示器（2.5dp 高，无转圈对话框）：平滑推进并在加载完成后淡出。
 */
class SilkProgressBar(context: Context) : View(context) {
    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shimmerPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var displayProgress = 0f
    private var targetProgress = 0f
    private var shimmerPhase = 0f
    private var progressAnim: ValueAnimator? = null
    private var shimmerAnim: ValueAnimator? = null

    init {
        visibility = GONE
        alpha = 0f
        refreshThemeColors()
    }

    fun refreshThemeColors() {
        val accent = SilkUi.color(context, R.color.accent)
        trackPaint.color = ColorUtils.setAlphaComponent(accent, 28)
        barPaint.color = accent
        invalidate()
    }

    fun startLoading() {
        visibility = VISIBLE
        animate().cancel()
        alpha = 1f
        displayProgress = 0.08f
        targetProgress = 0.15f
        ensureShimmer()
        invalidate()
    }

    fun setProgressValue(progress: Int) {
        if (progress >= 100) {
            finishLoading()
            return
        }
        if (visibility != VISIBLE) startLoading()
        val next = (progress / 100f).coerceIn(0.08f, 0.96f)
        if (next <= targetProgress) return
        targetProgress = next
        progressAnim?.cancel()
        progressAnim = ValueAnimator.ofFloat(displayProgress, targetProgress).apply {
            duration = 180L
            interpolator = SilkUi.EASE_OUT
            addUpdateListener {
                displayProgress = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    fun finishLoading() {
        if (visibility != VISIBLE) return
        progressAnim?.cancel()
        progressAnim = ValueAnimator.ofFloat(displayProgress, 1f).apply {
            duration = 160L
            interpolator = SilkUi.EASE_OUT
            addUpdateListener {
                displayProgress = it.animatedValue as Float
                invalidate()
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    animate().alpha(0f).setDuration(200L).withEndAction {
                        visibility = GONE
                        stopShimmer()
                        displayProgress = 0f
                        targetProgress = 0f
                    }.start()
                }
            })
            start()
        }
    }

    fun hideImmediately() {
        progressAnim?.cancel()
        stopShimmer()
        animate().cancel()
        visibility = GONE
        alpha = 0f
        displayProgress = 0f
        targetProgress = 0f
    }

    private fun ensureShimmer() {
        if (shimmerAnim?.isRunning == true) return
        shimmerAnim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 950L
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener {
                shimmerPhase = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    private fun stopShimmer() {
        shimmerAnim?.cancel()
        shimmerAnim = null
    }

    override fun onDetachedFromWindow() {
        progressAnim?.cancel()
        stopShimmer()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        canvas.drawRect(0f, 0f, w, h, trackPaint)
        val fillW = w * displayProgress
        if (fillW <= 0f) return
        canvas.drawRect(0f, 0f, fillW, h, barPaint)
        val bandW = w * 0.28f
        val x = -bandW + shimmerPhase * (fillW + bandW * 2f)
        val hi = ColorUtils.setAlphaComponent(SilkUi.color(context, R.color.btn_fg), 140)
        shimmerPaint.shader = LinearGradient(
            x, 0f, x + bandW, 0f,
            intArrayOf(Color.TRANSPARENT, hi, Color.TRANSPARENT),
            floatArrayOf(0f, 0.5f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.save()
        canvas.clipRect(0f, 0f, fillW, h)
        canvas.drawRect(0f, 0f, fillW, h, shimmerPaint)
        canvas.restore()
    }
}
