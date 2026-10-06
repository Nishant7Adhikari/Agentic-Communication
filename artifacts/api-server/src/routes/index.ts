import { Router, type IRouter } from "express";
import healthRouter from "./health";
import coordinationRouter from "./coordination";

const router: IRouter = Router();

router.use(healthRouter);
router.use(coordinationRouter);

export default router;
