import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { CreateRoleInput, Permission, UpdateRoleInput } from '@vendure/common/lib/generated-types';
import {
    CUSTOMER_ROLE_CODE,
    CUSTOMER_ROLE_DESCRIPTION,
    SUPER_ADMIN_ROLE_CODE,
    SUPER_ADMIN_ROLE_DESCRIPTION,
} from '@vendure/common/lib/shared-constants';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';
import { unique } from '@vendure/common/lib/unique';
import { Connection } from 'typeorm';

import { RequestContext } from '../../api/common/request-context';
import {
    EntityNotFoundError,
    ForbiddenError,
    InternalServerError,
    UserInputError,
} from '../../common/error/errors';
import { ListQueryOptions } from '../../common/types/common-types';
import { assertFound, idsAreEqual } from '../../common/utils';
import { Channel } from '../../entity/channel/channel.entity';
import { Role } from '../../entity/role/role.entity';
import { User } from '../../entity/user/user.entity';
import { ListQueryBuilder } from '../helpers/list-query-builder/list-query-builder';
import { getEntityOrThrow } from '../helpers/utils/get-entity-or-throw';
import { getUserChannelsPermissions } from '../helpers/utils/get-user-channels-permissions';
import { patchEntity } from '../helpers/utils/patch-entity';

import { ChannelService } from './channel.service';

@Injectable()
export class RoleService {
    constructor(
        @InjectConnection() private connection: Connection,
        private channelService: ChannelService,
        private listQueryBuilder: ListQueryBuilder,
    ) {}

    async initRoles() {
        await this.ensureSuperAdminRoleExists();
        await this.ensureCustomerRoleExists();
    }

    findAll(options?: ListQueryOptions<Role>): Promise<PaginatedList<Role>> {
        return this.listQueryBuilder
            .build(Role, options, { relations: ['channels'] })
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items,
                totalItems,
            }));
    }

    findOne(roleId: ID): Promise<Role | undefined> {
        return this.connection.manager.findOne(Role, roleId, {
            relations: ['channels'],
        });
    }

    getSuperAdminRole(): Promise<Role> {
        return this.getRoleByCode(SUPER_ADMIN_ROLE_CODE).then(role => {
            if (!role) {
                throw new InternalServerError(`error.super-admin-role-not-found`);
            }
            return role;
        });
    }

    getCustomerRole(): Promise<Role> {
        return this.getRoleByCode(CUSTOMER_ROLE_CODE).then(role => {
            if (!role) {
                throw new InternalServerError(`error.customer-role-not-found`);
            }
            return role;
        });
    }

    /**
     * Returns all the valid Permission values
     */
    getAllPermissions(): string[] {
        return Object.values(Permission);
    }

    /**
     * Returns true if the User has the specified permission on that Channel
     */
    async userHasPermissionOnChannel(userId: ID, channelId: ID, permission: Permission): Promise<boolean> {
        const user = await getEntityOrThrow(this.connection, User, userId, {
            relations: ['roles', 'roles.channels'],
        });
        const userChannels = getUserChannelsPermissions(user);
        const channel = userChannels.find(c => idsAreEqual(c.id, channelId));
        if (!channel) {
            return false;
        }
        return channel.permissions.includes(permission);
    }

    async create(ctx: RequestContext, input: CreateRoleInput): Promise<Role> {
        this.checkPermissionsAreValid(input.permissions);
        const targetChannel = input.channelId
            ? await getEntityOrThrow(this.connection, Channel, input.channelId)
            : ctx.channel;

        if (!ctx.activeUserId) {
            throw new ForbiddenError();
        }
        const hasPermission = await this.userHasPermissionOnChannel(
            ctx.activeUserId,
            targetChannel.id,
            Permission.CreateAdministrator,
        );
        if (!hasPermission) {
            throw new ForbiddenError();
        }
        return this.createRoleForChannel(input, targetChannel);
    }

    async update(input: UpdateRoleInput): Promise<Role> {
        this.checkPermissionsAreValid(input.permissions);
        const role = await this.findOne(input.id);
        if (!role) {
            throw new EntityNotFoundError('Role', input.id);
        }
        if (role.code === SUPER_ADMIN_ROLE_CODE || role.code === CUSTOMER_ROLE_CODE) {
            throw new InternalServerError(`error.cannot-modify-role`, { roleCode: role.code });
        }
        const updatedRole = patchEntity(role, {
            code: input.code,
            description: input.description,
            permissions: input.permissions
                ? unique([Permission.Authenticated, ...input.permissions])
                : undefined,
        });
        await this.connection.manager.save(updatedRole);
        return assertFound(this.findOne(role.id));
    }

    async assignRoleToChannel(roleId: ID, channelId: ID) {
        await this.channelService.assignToChannel(Role, roleId, channelId);
    }

    private checkPermissionsAreValid(permissions?: string[] | null) {
        if (!permissions) {
            return;
        }
        const allPermissions = this.getAllPermissions();
        for (const permission of permissions) {
            if (!allPermissions.includes(permission)) {
                throw new UserInputError('error.permission-invalid', { permission });
            }
        }
    }

    private getRoleByCode(code: string): Promise<Role | undefined> {
        return this.connection.getRepository(Role).findOne({
            where: { code },
        });
    }

    /**
     * Ensure that the SuperAdmin role exists and that it has all possible Permissions.
     */
    private async ensureSuperAdminRoleExists() {
        const allPermissions = Object.values(Permission).filter(p => p !== Permission.Owner);
        try {
            const superAdminRole = await this.getSuperAdminRole();
            const hasAllPermissions = allPermissions.every(permission =>
                superAdminRole.permissions.includes(permission),
            );
            if (!hasAllPermissions) {
                superAdminRole.permissions = allPermissions;
                await this.connection.getRepository(Role).save(superAdminRole);
            }
        } catch (err) {
            await this.createRoleForChannel(
                {
                    code: SUPER_ADMIN_ROLE_CODE,
                    description: SUPER_ADMIN_ROLE_DESCRIPTION,
                    permissions: allPermissions,
                },
                this.channelService.getDefaultChannel(),
            );
        }
    }

    private async ensureCustomerRoleExists() {
        try {
            await this.getCustomerRole();
        } catch (err) {
            await this.createRoleForChannel(
                {
                    code: CUSTOMER_ROLE_CODE,
                    description: CUSTOMER_ROLE_DESCRIPTION,
                    permissions: [Permission.Authenticated],
                },
                this.channelService.getDefaultChannel(),
            );
        }
    }

    private createRoleForChannel(input: CreateRoleInput, channel: Channel) {
        const role = new Role({
            code: input.code,
            description: input.description,
            permissions: unique([Permission.Authenticated, ...input.permissions]),
        });
        role.channels = [channel];
        return this.connection.manager.save(role);
    }
}
