import type { Kysely } from "kysely";

import type { Database } from "../types.js";
import { MenuRepository, type MenuWithItems } from "./menu.js";

export class SiteMenuRepository {
	private menus: MenuRepository;

	constructor(private db: Kysely<Database>) {
		this.menus = new MenuRepository(db);
	}

	async assign(siteId: string, menuId: string, location = "primary"): Promise<void> {
		await this.db
			.insertInto("_emdash_site_menus")
			.values({ site_id: siteId, menu_id: menuId, location })
			.onConflict((conflict) =>
				conflict.columns(["site_id", "location"]).doUpdateSet({ menu_id: menuId }),
			)
			.execute();
	}

	async find(siteId: string, location = "primary"): Promise<MenuWithItems | null> {
		const mapping = await this.db
			.selectFrom("_emdash_site_menus")
			.select("menu_id")
			.where("site_id", "=", siteId)
			.where("location", "=", location)
			.executeTakeFirst();
		return mapping ? this.menus.findWithItems(mapping.menu_id) : null;
	}
}
