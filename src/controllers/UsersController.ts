import { Controller, Ctx, Param, Body, QueryParams, Get, Post, Put, Patch, Delete, getMetadataArgsStorage } from "routing-controllers";
import { NotFoundError, ForbiddenError, BadRequestError } from "routing-controllers";
import { getFromContainer, MetadataStorage } from 'class-validator'

import { Authorized, HttpCode, UseAfter } from "routing-controllers";
import { sanitize} from "class-sanitizer";
import { hash, compare } from "bcryptjs";
import { PermissionClaims } from "../policies/PermissionClaims";
import { PaginationHeader } from "../middlewares/PaginationHeader";
import { Repository } from "../repository/Repository";
import { User } from "../models/User";
import { Role } from "../models/Role";
import { PaginationViewModel } from "../viewModels/PaginationViewModel";

import { UserViewModel } from "../viewModels/UserViewModel";
import { EmailViewModel } from "../viewModels/EmailViewModel";
import { PasswordViewModel } from "../viewModels/PasswordViewModel";
import { routingControllersToSpec } from 'routing-controllers-openapi'
import { validationMetadatasToSchemas } from 'class-validator-jsonschema'


const metadatas = (getFromContainer(MetadataStorage) as any).validationMetadatas

const join = { alias: "user", leftJoinAndSelect: { roles: "user.roles" } };
const updateBodyOptions = { validate: { skipMissingProperties: true } };
const SALT_ROUNDS = 10;
const schemas = validationMetadatasToSchemas(metadatas, {
    refPointerPrefix: '#/components/schemas'
  })


@Controller("/users")
export class UsersController {
    userRepository: any;
    roleRepository: any;

    constructor(private repository: Repository) {
        this.userRepository = this.repository.getRepository(User);
        this.roleRepository = this.repository.getRepository(Role);
    }

    @Get("/test/swagger.json")
    async getSwagger() {
        const storage = getMetadataArgsStorage();
        // const spec = routingControllersToSpec(storage)

        const spec = routingControllersToSpec(storage, {}, {
            components: { schemas },
            info: { title: 'My app', version: '1.2.0' }
          });


        return spec;
    }


    @Get()
    @Authorized(PermissionClaims.readUser)
    @UseAfter(PaginationHeader)
    async getAll( @Ctx() ctx: any, @QueryParams() pagination: PaginationViewModel) {
        const { take, skip, page } = pagination;
        const [users, count] = await this.userRepository.findAndCount({
            where: { tenantId: ctx.state.user.tenantId }, join, take, skip
        });
        ctx.state.pagination = { page, limit: take, count };
        users.map((user: any) => {
            user.roles = user.roles.map((role: any) => role.name);
            return user;
        });
        return users;
    }

    @Get("/:id")
    @Authorized(PermissionClaims.readUser)
    async get( @Ctx() ctx: any, @Param("id") id: number) {
        const query = { id, tenantId: ctx.state.user.tenantId };
        const user = await this.userRepository.findOne({ where: query, join });
        if (!user) {
            throw new NotFoundError(`user id '${ctx.params.id}' does not exist!`);
        }
        user.roles = user.roles.map((role: any) => role.name);
        return user;
    }

    @Post()
    @Authorized(PermissionClaims.createUser)
    @HttpCode(201)
    async create( @Ctx() ctx: any, @Body() viewModel: UserViewModel) {
        sanitize(viewModel);
        const user = this.userRepository.create(viewModel);
        if (await this.userRepository.findOne({ where: { email: user.email } })) {
            throw new BadRequestError(`email already exists!`);
        }
        user.tenantId = ctx.state.user.tenantId;
        user.lastLogin = new Date();
        user.password = await hash(viewModel.password, SALT_ROUNDS);
        user.roles = [];
        const roleNames = viewModel.roles || [];
        for (const roleName of roleNames) {
            if (roleName === "admin") {
                throw new BadRequestError(`role '${roleName}' is not allowed!`);
            }
            const query = {
                name: roleName,
                tenantId: ctx.state.user.tenantId
            };
            const role = await this.roleRepository.findOne({ where: query });
            if (!role) {
                throw new BadRequestError(`role '${roleName}' does not exist!`);
            }
            user.roles.push(role);
        }
        await this.userRepository.save(user);
        ctx.set("Location", `/v1/users/${user.id}`);
        return { message: "user created successfully!" };
    }

    @Patch("/:id")
    @Authorized(PermissionClaims.updateUser)
    @HttpCode(204)
    async update( @Ctx() ctx: any, @Param("id") id: number, @Body(updateBodyOptions) viewModel: UserViewModel) {
        const query = {
            id,
            tenantId: ctx.state.user.tenantId
        };
        const user = await this.userRepository.findOne({
            where: query,
            join
        });
        if (!user) {
            throw new NotFoundError(`user id '${ctx.params.id}' does not exist!`);
        }

        const roleNames = viewModel.roles;
        if (roleNames) {
            if (!ctx.state.user.role.includes("admin")) {
                // Only admin user can update current user's roles
                throw new ForbiddenError("you do not have permissions to update the user roles");
            }
            user.roles = [];
            for (const roleName of roleNames) {
                if (roleName === "admin") {
                    throw new BadRequestError(`role '${roleName}' is not allowed!`);
                }
                const roleQuery = {
                    name: roleName,
                    tenantId: ctx.state.user.tenantId
                };
                const role = await this.roleRepository.findOne({ where: roleQuery });
                if (!role) {
                    throw new BadRequestError(`role '${roleName}' does not exist!`);
                }
                user.roles.push(role);
            }
        }

        if (viewModel.name) {
            user.name = viewModel.name;
        }
        await this.userRepository.save(user);
    }

    @Put("/:id/password")
    @Authorized(PermissionClaims.updateUser)
    @HttpCode(204)
    async updatePassword( @Ctx() ctx: any, @Param("id") id: number, @Body() viewModel: PasswordViewModel) {
        const query = {
            id,
            tenantId: ctx.state.user.tenantId
        };
        const user = await this.userRepository.findOne({ where: query });
        if (!user) {
            throw new NotFoundError(`user id '${ctx.params.id}' does not exist!`);
        }

        if (!ctx.state.user.role.includes("admin")) {
            // Only admin or current user can update current user's profile
            if (ctx.state.user.sub !== user.id) {
                throw new ForbiddenError("you do not have permissions to update the user");
            }
        }
        const matched = await compare(viewModel.password, user.password);
        if (!matched) {
            throw new BadRequestError(`incorrect password!`);
        }
        user.password = await hash(viewModel.newPassword, SALT_ROUNDS);
        await this.userRepository.save(user);
    }

    @Put("/:id/email")
    @Authorized(PermissionClaims.updateUser)
    @HttpCode(204)
    async updateEmail( @Ctx() ctx: any, @Param("id") id: number, @Body() viewModel: EmailViewModel) {
        const query = {
            id,
            tenantId: ctx.state.user.tenantId
        };
        const user = await this.userRepository.findOne({ where: query });
        if (!user) {
            throw new NotFoundError(`user id '${ctx.params.id}' does not exist!`);
        }

        if (!ctx.state.user.role.includes("admin")) {
            // Only admin or current user can update current user's profile
            if (ctx.state.user.sub !== user.id) {
                throw new ForbiddenError("you do not have permissions to update the user");
            }
        }
        sanitize(viewModel);
        if (viewModel.email !== user.email) {
            if (await this.userRepository.findOne({ where: { email: viewModel.email } })) {
                throw new BadRequestError(`email already exists!`);
            }
        }
        user.email = viewModel.email;
        await this.userRepository.save(user);
    }

    @Delete("/:id")
    @Authorized(PermissionClaims.deleteUser)
    @HttpCode(204)
    async delete( @Ctx() ctx: any, @Param("id") id: number) {
        const query = {
            id,
            tenantId: ctx.state.user.tenantId
        };
        const user = await this.userRepository.findOne({
            where: query,
            join
        });
        if (!user) {
            throw new NotFoundError(`user id '${ctx.params.id}' does not exist!`);
        }
        if (user.roles.length) {
            for (const role of user.roles) {
                if (role.name === "admin") {
                    throw new ForbiddenError("admin user cannot be deleted");
                }
            }
        }
        await this.userRepository.remove(user);
    }

}
// const storage = getMetadataArgsStorage()
// const spec = routingControllersToSpec(storage)
// console.log(spec)