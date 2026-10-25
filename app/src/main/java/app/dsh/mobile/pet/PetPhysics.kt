package app.dsh.mobile.pet

import kotlin.math.abs

data class PetBody(
    var x: Double,
    var y: Double,
    var vx: Double,
    var vy: Double,
)

data class PetBounds(
    val minX: Double,
    val maxX: Double,
    val minY: Double,
    val maxY: Double,
)

data class PetStep(
    val body: PetBody,
    val bounced: Boolean,
    val atRest: Boolean,
)

/**
 * 甩抛物理的极小实现。
 *
 * 常量与 dsh-pet-android（MIT，源自 dsh-pet src/shared/physics.ts）同值：
 * gravity=1400、restitution=0.78、groundFriction=2.5、Q 弹 220ms/压深 0.55。
 * 只保留本功能需要的最小公式，不复制其多宠/台词/音效逻辑。
 */
object PetPhysics {
    const val GRAVITY = 1400.0
    const val RESTITUTION = 0.78
    const val GROUND_FRICTION = 2.5
    const val SQUASH_MS = 220L
    const val SQUASH_AMOUNT = 0.55
    const val REST_SPEED = 40.0

    fun step(body: PetBody, dt: Double, bounds: PetBounds): PetStep {
        var bounced = false
        body.vy += GRAVITY * dt
        body.x += body.vx * dt
        body.y += body.vy * dt

        if (body.x < bounds.minX) {
            body.x = bounds.minX
            body.vx = -body.vx * RESTITUTION
            bounced = true
        } else if (body.x > bounds.maxX) {
            body.x = bounds.maxX
            body.vx = -body.vx * RESTITUTION
            bounced = true
        }

        if (body.y < bounds.minY) {
            body.y = bounds.minY
            body.vy = -body.vy * RESTITUTION
            bounced = true
        } else if (body.y > bounds.maxY) {
            body.y = bounds.maxY
            if (abs(body.vy) > REST_SPEED) {
                bounced = true
            }
            body.vy = -body.vy * RESTITUTION
        }

        val onGround = body.y >= bounds.maxY - 0.5
        if (onGround) {
            body.vx -= body.vx * GROUND_FRICTION * dt
            if (abs(body.vx) < 2.0) body.vx = 0.0
            if (abs(body.vy) < REST_SPEED) body.vy = 0.0
        }

        val atRest = onGround && abs(body.vx) < 1.0 && abs(body.vy) < 1.0
        if (atRest) {
            body.vx = 0.0
            body.vy = 0.0
        }
        return PetStep(body, bounced, atRest)
    }
}
