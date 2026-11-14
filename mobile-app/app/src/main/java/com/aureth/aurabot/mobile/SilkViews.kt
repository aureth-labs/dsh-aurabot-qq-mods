package com.aureth.aurabot.mobile

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.view.animation.PathInterpolator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.drawable.DrawableCompat
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Silk 风格液态玻璃圆角/圆形绘制器：
 * 半透磨砂底 + 顶部纵向高光 + 对角线 3 段高光折边（liquidRim）+ 极细外轮廓线。
 */
class LiquidGlassDrawable(
    private val fillColor: Int,
    private val topSheenColor: Int,
    private val rimHi: Int,
    private val rimLo: Int,
    private val rimBack: Int,
    private val outerStrokeColor: Int,
    private val cornerRadiusPx: Float = 0f,
    private val rimWidthPx: Float = 2f,
    private val outerStrokeWidthPx: Float = 1f,
    private val isCircle: Boolean = false
) : Drawable() {

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = fillColor
    }
    private val sheenPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }
    private val rimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = rimWidthPx
    }
    private val outerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = outerStrokeWidthPx
        color = outerStrokeColor
    }
    private val rect = RectF()
    private val rimRect = RectF()
    private val outerRect = RectF()
    private var lastW = -1
    private var lastH = -1

    override fun onBoundsChange(bounds: Rect) {
        super.onBoundsChange(bounds)
        lastW = -1
        lastH = -1
    }

    private fun ensureShaders(w: Float, h: Float) {
        if (lastW == w.roundToInt() && lastH == h.roundToInt()) return
        lastW = w.roundToInt()
        lastH = h.roundToInt()

        sheenPaint.shader = LinearGradient(
            0f, 0f, 0f, h * 0.56f,
            intArrayOf(topSheenColor, Color.TRANSPARENT),
            floatArrayOf(0f, 1f),
            Shader.TileMode.CLAMP
        )
        rimPaint.shader = LinearGradient(
            0f, 0f, w, h,
            intArrayOf(rimHi, rimLo, rimBack),
            floatArrayOf(0f, 0.45f, 1f),
            Shader.TileMode.CLAMP
        )
    }

    override fun draw(canvas: Canvas) {
        val b = bounds
        val w = b.width().toFloat()
        val h = b.height().toFloat()
        if (w <= 0f || h <= 0f) return

        ensureShaders(w, h)
        val radius = if (isCircle) min(w, h) * 0.5f else min(cornerRadiusPx, min(w, h) * 0.5f)
        rect.set(b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), b.bottom.toFloat())

        canvas.drawRoundRect(rect, radius, radius, fillPaint)
        if (Color.alpha(topSheenColor) > 0) {
            canvas.drawRoundRect(rect, radius, radius, sheenPaint)
        }

        val rimInset = rimWidthPx * 0.5f + outerStrokeWidthPx * 0.5f
        rimRect.set(
            rect.left + rimInset,
            rect.top + rimInset,
            rect.right - rimInset,
            rect.bottom - rimInset
        )
        val rimRadius = (radius - rimInset).coerceAtLeast(0f)
        canvas.drawRoundRect(rimRect, rimRadius, rimRadius, rimPaint)

        if (outerStrokeWidthPx > 0f && Color.alpha(outerStrokeColor) > 0) {
            val outInset = outerStrokeWidthPx * 0.5f
            outerRect.set(
                rect.left + outInset,
                rect.top + outInset,
                rect.right - outInset,
                rect.bottom - outInset
            )
            val outRadius = (radius - outInset).coerceAtLeast(0f)
            canvas.drawRoundRect(outerRect, outRadius, outRadius, outerPaint)
        }
    }

    override fun setAlpha(alpha: Int) {
        fillPaint.alpha = alpha
        sheenPaint.alpha = alpha
        rimPaint.alpha = alpha
        outerPaint.alpha = alpha
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        fillPaint.colorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/**
 * 视觉体系工具集：延续 Silk 钱包的克制质感，严格遵循单一颜色真源与系统字体。
 */
object SilkUi {
    val silkEase = PathInterpolator(0.22f, 1f, 0.36f, 1f)
    val EASE_OUT: PathInterpolator = silkEase
    private val springOvershoot = OvershootInterpolator(1.6f)

    fun dp(ctx: Context, v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).roundToInt()

    fun dpF(ctx: Context, v: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics)

    fun color(ctx: Context, resId: Int): Int = ContextCompat.getColor(ctx, resId)

    fun space(ctx: Context, heightDp: Float): View = View(ctx).apply {
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(ctx, heightDp))
    }

    /**
     * Silk Q 弹按压缩放：按下快速收敛，松开带轻柔弹性回弹，无廉价灰框涟漪。
     */
    @SuppressLint("ClickableViewAccessibility")
    fun attachPressScale(view: View, pressedScale: Float = 0.96f) {
        view.setOnTouchListener { v, event ->
            if (!v.isEnabled) return@setOnTouchListener false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    v.animate().cancel()
                    v.animate()
                        .scaleX(pressedScale)
                        .scaleY(pressedScale)
                        .alpha(0.92f)
                        .setDuration(90L)
                        .setInterpolator(DecelerateInterpolator())
                        .start()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.animate().cancel()
                    v.animate()
                        .scaleX(1f)
                        .scaleY(1f)
                        .alpha(1f)
                        .setDuration(240L)
                        .setInterpolator(springOvershoot)
                        .start()
                }
            }
            false
        }
    }

    fun hapticClick(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    }

    fun hapticConfirm(view: View) {
        hapticSuccess(view)
    }

    fun hapticSuccess(view: View) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        } else {
            view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        }
    }

    /**
     * Silk 液态玻璃卡片背景（浅色纯白微透高光折边，深色曜石磨砂折边）。
     */
    fun glassCardBackground(ctx: Context, radiusDp: Float = 22f): Drawable =
        LiquidGlassDrawable(
            fillColor = color(ctx, R.color.glass_tint),
            topSheenColor = color(ctx, R.color.rim_top_sheen),
            rimHi = color(ctx, R.color.rim_hi),
            rimLo = color(ctx, R.color.rim_lo),
            rimBack = color(ctx, R.color.rim_back),
            outerStrokeColor = color(ctx, R.color.stroke),
            cornerRadiusPx = dpF(ctx, radiusDp),
            rimWidthPx = dpF(ctx, 1.5f),
            outerStrokeWidthPx = maxOf(1f, dpF(ctx, 0.65f)),
            isCircle = false
        )

    /**
     * 深色相机界面上的半透液态玻璃卡片或胶囊。
     */
    fun darkGlassBackground(ctx: Context, radiusDp: Float = 22f, isCircle: Boolean = false): Drawable {
        val fg = color(ctx, R.color.scan_fg)
        return LiquidGlassDrawable(
            fillColor = color(ctx, R.color.scan_surface),
            topSheenColor = ColorUtils.setAlphaComponent(fg, 22),
            rimHi = ColorUtils.setAlphaComponent(fg, 96),
            rimLo = ColorUtils.setAlphaComponent(fg, 14),
            rimBack = ColorUtils.setAlphaComponent(fg, 44),
            outerStrokeColor = ColorUtils.setAlphaComponent(fg, 32),
            cornerRadiusPx = dpF(ctx, radiusDp),
            rimWidthPx = dpF(ctx, 1.2f),
            outerStrokeWidthPx = maxOf(1f, dpF(ctx, 0.5f)),
            isCircle = isCircle
        )
    }

    fun pillBackground(ctx: Context, radiusDp: Float = 999f): Drawable =
        LiquidGlassDrawable(
            fillColor = color(ctx, R.color.surface_subtle),
            topSheenColor = color(ctx, R.color.rim_top_sheen),
            rimHi = color(ctx, R.color.rim_hi),
            rimLo = color(ctx, R.color.rim_lo),
            rimBack = color(ctx, R.color.rim_back),
            outerStrokeColor = color(ctx, R.color.stroke),
            cornerRadiusPx = dpF(ctx, radiusDp),
            rimWidthPx = dpF(ctx, 1.1f),
            outerStrokeWidthPx = maxOf(1f, dpF(ctx, 0.6f)),
            isCircle = radiusDp >= 900f
        )

    fun rippleRect(
        ctx: Context,
        fillColor: Int,
        rippleColor: Int,
        radiusDp: Float,
        strokeColor: Int? = null,
        strokeWidthDp: Float = 1f
    ): Drawable {
        val radius = dpF(ctx, radiusDp)
        val content = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radius
            setColor(fillColor)
            if (strokeColor != null) {
                setStroke(dp(ctx, strokeWidthDp), strokeColor)
            }
        }
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radius
            setColor(color(ctx, R.color.btn_fg))
        }
        return RippleDrawable(android.content.res.ColorStateList.valueOf(rippleColor), content, mask)
    }

    /**
     * 圆形液态玻璃徽章容器（呼应 Silk 锁定/欢迎页的居中漂浮玻璃圆章）。
     */
    fun liquidCircleBadge(ctx: Context, sizeDp: Float = 72f, child: View): FrameLayout {
        val size = dp(ctx, sizeDp)
        val badge = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(size, size)
            background = LiquidGlassDrawable(
                fillColor = color(ctx, R.color.glass_tint),
                topSheenColor = color(ctx, R.color.rim_top_sheen),
                rimHi = color(ctx, R.color.rim_hi),
                rimLo = color(ctx, R.color.rim_lo),
                rimBack = color(ctx, R.color.rim_back),
                outerStrokeColor = color(ctx, R.color.stroke_strong),
                rimWidthPx = dpF(ctx, 2f),
                outerStrokeWidthPx = maxOf(1f, dpF(ctx, 0.65f)),
                isCircle = true
            )
            elevation = dpF(ctx, 6f)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                outlineSpotShadowColor = color(ctx, R.color.accent_glow)
                outlineAmbientShadowColor = color(ctx, R.color.stroke)
            }
            addView(child, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER
            ))
        }
        return badge
    }

    /**
     * Silk 分组卡片中的图标+文案行（参考 Silk 设置页，左为 36dp 柔和色块图标，右为标题与说明）。
     */
    fun settingRow(
        ctx: Context,
        iconRes: Int,
        title: String,
        subtitle: String,
        isError: Boolean = false
    ): LinearLayout {
        val tint = color(ctx, if (isError) R.color.error else R.color.accent)
        val badgeBgColor = color(ctx, if (isError) R.color.error_soft else R.color.accent_soft)
        val iconBoxSize = dp(ctx, 36f)

        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(ctx, 16f), dp(ctx, 14f), dp(ctx, 16f), dp(ctx, 14f))
        }

        val iconWrap = FrameLayout(ctx).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dpF(ctx, 11f)
                setColor(badgeBgColor)
            }
        }
        val iv = ImageView(ctx).apply {
            setImageResource(iconRes)
            setColorFilter(tint)
        }
        val iconSize = dp(ctx, 18f)
        iconWrap.addView(iv, FrameLayout.LayoutParams(iconSize, iconSize, Gravity.CENTER))
        row.addView(iconWrap, LinearLayout.LayoutParams(iconBoxSize, iconBoxSize).apply {
            marginEnd = dp(ctx, 14f)
        })

        val textCol = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
        }
        textCol.addView(TextView(ctx).apply {
            text = title
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setTextColor(color(ctx, R.color.fg))
        })
        textCol.addView(TextView(ctx).apply {
            text = subtitle
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(color(ctx, R.color.muted))
            setLineSpacing(dpF(ctx, 2f), 1f)
            setPadding(0, dp(ctx, 2f), 0, 0)
        })
        row.addView(textCol, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }

    fun hairlineDivider(ctx: Context, startInsetDp: Float = 66f): View =
        View(ctx).apply {
            setBackgroundColor(color(ctx, R.color.stroke))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                maxOf(1, dp(ctx, 0.6f))
            ).apply {
                marginStart = dp(ctx, startInsetDp)
                marginEnd = dp(ctx, 16f)
            }
        }

    /**
     * Silk 主行动按钮：浅色墨黑实心、深色珍珠白实心，54dp 大胶囊 + 精致玻璃高光折边，不铺大蓝块。
     */
    fun primaryButton(
        ctx: Context,
        text: String,
        iconRes: Int = 0,
        onClick: (View) -> Unit = {}
    ): LinearLayout {
        val btnFg = color(ctx, R.color.btn_fg)
        val btnBg = color(ctx, R.color.btn_bg)
        val btn = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            minimumHeight = dp(ctx, 54f)
            setPadding(dp(ctx, 24f), dp(ctx, 14f), dp(ctx, 24f), dp(ctx, 14f))
            background = LiquidGlassDrawable(
                fillColor = btnBg,
                topSheenColor = ColorUtils.setAlphaComponent(btnFg, 20),
                rimHi = ColorUtils.setAlphaComponent(btnFg, 55),
                rimLo = ColorUtils.setAlphaComponent(btnFg, 8),
                rimBack = ColorUtils.setAlphaComponent(btnFg, 24),
                outerStrokeColor = Color.TRANSPARENT,
                cornerRadiusPx = dpF(ctx, 27f),
                rimWidthPx = dpF(ctx, 1.1f),
                outerStrokeWidthPx = 0f,
                isCircle = false
            )
            elevation = dpF(ctx, 3f)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                outlineSpotShadowColor = color(ctx, R.color.stroke_strong)
                outlineAmbientShadowColor = color(ctx, R.color.stroke)
            }
            isClickable = true
            isFocusable = true
        }
        if (iconRes != 0) {
            val iconView = ImageView(ctx).apply {
                val raw = ContextCompat.getDrawable(ctx, iconRes)?.mutate()
                if (raw != null) {
                    DrawableCompat.setTint(raw, btnFg)
                    setImageDrawable(raw)
                }
            }
            val iconSize = dp(ctx, 19f)
            btn.addView(iconView, LinearLayout.LayoutParams(iconSize, iconSize).apply {
                marginEnd = dp(ctx, 9f)
            })
        }
        val tv = TextView(ctx).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            letterSpacing = 0.01f
            setTextColor(btnFg)
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
            gravity = Gravity.CENTER
        }
        btn.addView(tv)
        attachPressScale(btn)
        btn.setOnClickListener { v ->
            hapticClick(v)
            onClick(v)
        }
        return btn
    }

    /**
     * 次按钮（描边玻璃胶囊或纯文字）。
     */
    fun secondaryButton(
        ctx: Context,
        text: String,
        outlined: Boolean = true,
        onClick: (View) -> Unit = {}
    ): TextView {
        val tv = TextView(ctx).apply {
            this.text = text
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            if (outlined) {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setTextColor(color(ctx, R.color.fg))
                minimumHeight = dp(ctx, 50f)
                setPadding(dp(ctx, 22f), dp(ctx, 13f), dp(ctx, 22f), dp(ctx, 13f))
                background = LiquidGlassDrawable(
                    fillColor = color(ctx, R.color.surface_subtle),
                    topSheenColor = color(ctx, R.color.rim_top_sheen),
                    rimHi = color(ctx, R.color.rim_hi),
                    rimLo = color(ctx, R.color.rim_lo),
                    rimBack = color(ctx, R.color.rim_back),
                    outerStrokeColor = color(ctx, R.color.stroke_strong),
                    cornerRadiusPx = dpF(ctx, 25f),
                    rimWidthPx = dpF(ctx, 1.2f),
                    outerStrokeWidthPx = maxOf(1f, dpF(ctx, 0.65f)),
                    isCircle = false
                )
            } else {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setTextColor(color(ctx, R.color.muted))
                minimumHeight = dp(ctx, 44f)
                setPadding(dp(ctx, 16f), dp(ctx, 10f), dp(ctx, 16f), dp(ctx, 10f))
            }
        }
        attachPressScale(tv, if (outlined) 0.96f else 0.95f)
        tv.setOnClickListener { v ->
            hapticClick(v)
            onClick(v)
        }
        return tv
    }

    fun styledInput(ctx: Context, hintText: String): EditText {
        val strokeRest = color(ctx, R.color.stroke_strong)
        val strokeFocus = color(ctx, R.color.accent)
        val fill = color(ctx, R.color.surface_subtle)
        val radius = dpF(ctx, 16f)

        fun makeBg(focused: Boolean) = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radius
            setColor(fill)
            setStroke(dp(ctx, if (focused) 1.5f else 0.75f), if (focused) strokeFocus else strokeRest)
        }

        return EditText(ctx).apply {
            hint = hintText
            setHintTextColor(color(ctx, R.color.muted))
            setTextColor(color(ctx, R.color.fg))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            background = makeBg(false)
            setPadding(dp(ctx, 16f), dp(ctx, 14f), dp(ctx, 16f), dp(ctx, 14f))
            minHeight = dp(ctx, 50f)
            setOnFocusChangeListener { _, hasFocus ->
                background = makeBg(hasFocus)
            }
        }
    }

    fun animateEnter(view: View, startDelayMs: Long = 0L) {
        view.alpha = 0f
        view.translationY = dpF(view.context, 14f)
        view.animate()
            .alpha(1f)
            .translationY(0f)
            .setStartDelay(startDelayMs)
            .setDuration(250L)
            .setInterpolator(silkEase)
            .start()
    }
}

/**
 * 极克制的 Silk 顶部微光气氛层：仅在屏幕顶部 38% 区间弥散，向下无接缝彻底消散于纯白/曜石底。
 */
class AuroraBackdropView(context: Context) : View(context) {
    private val paint1 = Paint(Paint.ANTI_ALIAS_FLAG)
    private val paint2 = Paint(Paint.ANTI_ALIAS_FLAG)
    private var lastW = 0
    private var lastH = 0

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        if (width != lastW || height != lastH) {
            lastW = width
            lastH = height
            val accent = SilkUi.color(context, R.color.accent)
            val violet = SilkUi.color(context, R.color.accent_violet)
            // 中心略下移并保证半径 < 距顶部距离，确保 y=0 处透明度严格为 0，与状态栏无缝衔接
            val r1 = (h * 0.22f).coerceAtMost(w * 0.65f)
            paint1.shader = RadialGradient(
                w * 0.20f, h * 0.24f, r1,
                intArrayOf(ColorUtils.setAlphaComponent(accent, 18), Color.TRANSPARENT),
                floatArrayOf(0f, 1f),
                Shader.TileMode.CLAMP
            )
            val r2 = (h * 0.24f).coerceAtMost(w * 0.65f)
            paint2.shader = RadialGradient(
                w * 0.84f, h * 0.30f, r2,
                intArrayOf(ColorUtils.setAlphaComponent(violet, 15), Color.TRANSPARENT),
                floatArrayOf(0f, 1f),
                Shader.TileMode.CLAMP
            )
        }
        canvas.drawRect(0f, 0f, w, h, paint1)
        canvas.drawRect(0f, 0f, w, h, paint2)
    }
}

/**
 * 与新启动图标一致的非对称雕塑感极光气泡标志，镂空双四角星，支持斜向流光动画。
 */
class BrandMarkView(context: Context) : View(context) {
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val sheenPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val clearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    private val sweepPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_ATOP)
    }

    private val bubblePath = Path()
    private val starMainPath = Path()
    private val starSubPath = Path()
    private val rect = RectF()
    private var sheenProgress = -1f
    private var lastSize = 0f

    init {
        setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    private fun addFourPointStar(out: Path, cx: Float, cy: Float, radius: Float) {
        out.moveTo(cx, cy - radius)
        out.quadTo(cx, cy, cx + radius, cy)
        out.quadTo(cx, cy, cx, cy + radius)
        out.quadTo(cx, cy, cx - radius, cy)
        out.quadTo(cx, cy, cx, cy - radius)
        out.close()
    }

    private fun ensureGeometry(size: Float) {
        if (size == lastSize) return
        lastSize = size

        val indigo = SilkUi.color(context, R.color.accent_indigo)
        val blue = SilkUi.color(context, R.color.accent)
        val violet = SilkUi.color(context, R.color.accent_violet)
        val rose = SilkUi.color(context, R.color.accent_rose)

        fillPaint.shader = LinearGradient(
            size * 0.14f, size * 0.14f, size * 0.88f, size * 0.88f,
            intArrayOf(indigo, blue, violet, rose),
            floatArrayOf(0f, 0.36f, 0.70f, 1f),
            Shader.TileMode.CLAMP
        )

        sheenPaint.shader = LinearGradient(
            0f, size * 0.12f, 0f, size * 0.56f,
            intArrayOf(Color.argb(66, 255, 255, 255), Color.TRANSPARENT),
            floatArrayOf(0f, 1f),
            Shader.TileMode.CLAMP
        )

        // 与生成脚本 gen_icon.py 完全一致的比例（在 [0.16..0.84] 居中区域内）
        val left = size * 0.16f
        val top = size * 0.18f
        val right = size * 0.84f
        val bottom = size * 0.80f
        rect.set(left, top, right, bottom)
        val rBig = size * 0.275f
        val rTail = size * 0.068f
        bubblePath.reset()
        bubblePath.addRoundRect(
            rect,
            floatArrayOf(rBig, rBig, rBig, rBig, rBig, rBig, rTail, rTail),
            Path.Direction.CW
        )

        starMainPath.reset()
        addFourPointStar(starMainPath, size * 0.43f, size * 0.50f, size * 0.135f)
        starSubPath.reset()
        addFourPointStar(starSubPath, size * 0.62f, size * 0.39f, size * 0.068f)
    }

    override fun onDraw(canvas: Canvas) {
        val size = min(width, height).toFloat()
        if (size <= 0f) return
        ensureGeometry(size)

        val ox = (width - size) * 0.5f
        val oy = (height - size) * 0.5f
        canvas.save()
        canvas.translate(ox, oy)

        val layer = canvas.saveLayer(0f, 0f, size, size, null)
        canvas.drawPath(bubblePath, fillPaint)
        canvas.drawPath(bubblePath, sheenPaint)
        canvas.drawPath(starMainPath, clearPaint)
        canvas.drawPath(starSubPath, clearPaint)

        if (sheenProgress in 0f..1f) {
            val sx = -size * 0.5f + size * 2.0f * sheenProgress
            val band = size * 0.45f
            sweepPaint.shader = LinearGradient(
                sx - band, 0f, sx + band, size,
                intArrayOf(Color.TRANSPARENT, Color.argb(120, 255, 255, 255), Color.TRANSPARENT),
                floatArrayOf(0f, 0.5f, 1f),
                Shader.TileMode.CLAMP
            )
            canvas.drawRect(0f, 0f, size, size, sweepPaint)
        }
        canvas.restoreToCount(layer)
        canvas.restore()
    }

    fun playColdStart(onFinished: () -> Unit) {
        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 520L
            interpolator = SilkUi.silkEase
            addUpdateListener {
                sheenProgress = it.animatedValue as Float
                invalidate()
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    sheenProgress = -1f
                    invalidate()
                    onFinished()
                }
            })
            start()
        }
    }
}

/**
 * 仿 Silk 钱包 Intro 的斜体衬线 "Aura" 品牌字标：冷启动时一道极光斜向流光扫过（<= 560ms）。
 */
class SilkIntroWordmarkView(context: Context) : View(context) {
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = SilkUi.color(context, R.color.fg)
        typeface = Typeface.create(Typeface.SERIF, Typeface.BOLD_ITALIC)
        textSize = SilkUi.dpF(context, 42f)
        letterSpacing = -0.02f
        textAlign = Paint.Align.CENTER
    }
    private val sweepPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_ATOP)
    }
    private var progress = 0f

    init {
        setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val fm = textPaint.fontMetrics
        val baseline = h * 0.5f - (fm.ascent + fm.descent) * 0.5f

        val layer = canvas.saveLayer(0f, 0f, w, h, null)
        canvas.drawText("Aura", w * 0.5f, baseline, textPaint)

        val sweepW = w * 0.45f
        val x = -sweepW + (w + sweepW * 2f) * progress
        val indigo = SilkUi.color(context, R.color.accent_indigo)
        val blue = SilkUi.color(context, R.color.accent)
        val violet = SilkUi.color(context, R.color.accent_violet)
        val rose = SilkUi.color(context, R.color.accent_rose)
        sweepPaint.shader = LinearGradient(
            x - sweepW, 0f, x + sweepW, h,
            intArrayOf(
                Color.TRANSPARENT,
                ColorUtils.setAlphaComponent(indigo, 190),
                ColorUtils.setAlphaComponent(blue, 235),
                ColorUtils.setAlphaComponent(violet, 220),
                ColorUtils.setAlphaComponent(rose, 190),
                Color.TRANSPARENT
            ),
            floatArrayOf(0f, 0.22f, 0.45f, 0.65f, 0.82f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.drawRect(0f, 0f, w, h, sweepPaint)
        canvas.restoreToCount(layer)
    }

    fun playAuroraSweep(onDone: () -> Unit) {
        scaleX = 0.96f
        scaleY = 0.96f
        alpha = 0f
        animate()
            .alpha(1f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(240L)
            .setInterpolator(SilkUi.silkEase)
            .start()

        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 540L
            interpolator = SilkUi.silkEase
            addUpdateListener {
                progress = it.animatedValue as Float
                invalidate()
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    onDone()
                }
            })
            start()
        }
    }
}

/**
 * 顶部 2.5dp 极细极光进度条（WebView 加载进度用）。
 */
class SilkProgressBar(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rect = RectF()
    private var animProgress = 0f
    private var fadeAnim: ObjectAnimator? = null
    private var lastW = 0

    fun refreshThemeColors() {
        lastW = 0
        invalidate()
    }

    fun startLoading() {
        setProgressPercent(12)
    }

    fun setProgressValue(percent: Int) {
        setProgressPercent(percent)
    }

    fun finishLoading() {
        setProgressPercent(100)
    }

    fun hideImmediately() {
        fadeAnim?.cancel()
        visibility = GONE
        alpha = 0f
        animProgress = 0f
        invalidate()
    }

    fun setProgressPercent(percent: Int) {
        val clamped = percent.coerceIn(0, 100)
        if (clamped < 100) {
            fadeAnim?.cancel()
            alpha = 1f
            visibility = VISIBLE
            ValueAnimator.ofFloat(animProgress, clamped / 100f).apply {
                duration = 160L
                addUpdateListener {
                    animProgress = it.animatedValue as Float
                    invalidate()
                }
                start()
            }
        } else {
            ValueAnimator.ofFloat(animProgress, 1f).apply {
                duration = 140L
                addUpdateListener {
                    animProgress = it.animatedValue as Float
                    invalidate()
                }
                addListener(object : AnimatorListenerAdapter() {
                    override fun onAnimationEnd(animation: Animator) {
                        fadeAnim?.cancel()
                        fadeAnim = ObjectAnimator.ofFloat(this@SilkProgressBar, ALPHA, 1f, 0f).apply {
                            duration = 220L
                            addListener(object : AnimatorListenerAdapter() {
                                override fun onAnimationEnd(animation: Animator) {
                                    visibility = GONE
                                    animProgress = 0f
                                }
                            })
                            start()
                        }
                    }
                })
                start()
            }
        }
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f || animProgress <= 0f) return
        if (width != lastW) {
            lastW = width
            paint.shader = LinearGradient(
                0f, 0f, w, 0f,
                intArrayOf(
                    SilkUi.color(context, R.color.accent_indigo),
                    SilkUi.color(context, R.color.accent),
                    SilkUi.color(context, R.color.accent_violet),
                    SilkUi.color(context, R.color.accent_rose)
                ),
                null,
                Shader.TileMode.CLAMP
            )
        }
        rect.set(0f, 0f, w * animProgress, h)
        canvas.drawRoundRect(rect, h * 0.5f, h * 0.5f, paint)
    }
}
