/**
 * SuperAdmin Routes
 * 
 * Registers superadmin routes and initializes the module.
 */

import { SuperAdminRouter, initializeSuperAdmin } from "../superadmin";
import { databaseInit } from "../database/databaseConnection";

let initialized = false;
let initPromise: Promise<void> | null = null;

async function initModule(): Promise<void> {
  if (initialized) return;
  
  if (initPromise) {
    return initPromise;
  }
  
  initPromise = (async () => {
    try {
      const database = await databaseInit();
      
      if (database && database.sequelize) {
        const models: Record<string, any> = {};
        Object.keys(database).forEach(key => {
          if (key !== "sequelize" && key !== "Sequelize" && database[key]) {
            models[key] = database[key];
          }
        });
        
        initializeSuperAdmin(database.sequelize, models);
        initialized = true;
        console.log("✅ SuperAdmin module initialized with", Object.keys(models).length, "models");
      }
    } catch (error) {
      console.error("❌ Failed to initialize SuperAdmin module:", error);
      initPromise = null;
      throw error;
    }
  })();
  
  return initPromise;
}

export default function setupSuperAdmin(app: any): void {
  // Middleware that MUST complete init before proceeding
  app.use("/api/superadmin", async (req: any, res: any, next: any) => {
    try {
      await initModule();
      next();
    } catch (error) {
      res.status(503).json({ success: false, error: "SuperAdmin module initializing, please retry" });
    }
  });

  // Mount the superadmin routes
  app.use("/api/superadmin", SuperAdminRouter);
  console.log("🔐 SuperAdmin routes mounted at /api/superadmin");
  
  // Fire off init in background (non-blocking)
  initModule().catch(console.error);
}
