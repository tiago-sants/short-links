import type { FastifyInstance } from "fastify"
import { ZodError, z } from "zod"
import { sql } from "../lib/postgres"
import { redis } from "../lib/redis"

export default async function routes(fastify: FastifyInstance) {
	fastify.post("/api/links", async (request, reply) => {
		try {
			const createLinkSchema = z
				.object({
					code: z
						.string({
							required_error: "Code is required",
						})
						.min(3),
					url: z
						.string({
							required_error: "URL is required",
						})
						.url(),
				})
				.strict()

			const { code, url } = createLinkSchema.parse(request.body)

			const linkExists = await sql /*sql*/`
				SELECT id
				FROM short_links
				WHERE short_links.code = ${code}
			`

			if (linkExists[0] === null) {
				return reply.status(409).send({
					message: "Link already exists",
				})
			}

			const result = await sql /*sql*/`
        INSERT INTO short_links (code, original_url) VALUES (${code}, ${url})
        RETURNING id
      `
			const link = result[0]

			return reply.status(201).send({
				shortLinkId: link.id,
			})
		} catch (err) {
			if (err instanceof ZodError) {
				const formattedErrors = err.issues.map((err) => ({
					path: err.path[0],
					message: err.message,
				}))

				return reply.status(400).send(formattedErrors)
			}

			return reply.status(500).send("Internal Server Error")
		}
	})

	fastify.get("/api/links", async () => {
		const links = await sql /*sql*/`
			SELECT *
			FROM short_links
			ORDER BY created_at DESC
		`

		return links
	})

	fastify.get("/:code", async (request, reply) => {
		try {
			const getLinkSchema = z.object({
				code: z.string().min(3),
			})

			const { code } = getLinkSchema.parse(request.params)

			const result = await sql /*sql*/`
				SELECT id, original_url
				FROM short_links
				WHERE short_links.code = ${code}
			`

			if (result.length === 0) {
				return reply.status(404).send({
					message: "Link not found",
				})
			}

			const link = result[0]

			await redis.connect()

			await redis.zIncrBy("metrics", 1, String(link.id))

			return reply.redirect(301, link.original_url)
		} catch (err) {
			return reply.status(500).send({
				message: "Internal Server Error",
			})
		} finally {
			await redis.disconnect()
		}
	})

	fastify.get("/api/metrics", async (_request, reply) => {
		try {
			await redis.connect()

			const result = await redis.zRangeByScoreWithScores("metrics", 0, 50)

			const metrics = result
				.sort((a, b) => b.score - a.score)
				.map((item) => ({
					shortLinkId: Number(item.value),
					clicks: item.score,
				}))

			return metrics
		} catch (err) {
			return reply.status(500).send({
				message: "Internal Server Error",
			})
		} finally {
			await redis.disconnect()
		}
	})
}
